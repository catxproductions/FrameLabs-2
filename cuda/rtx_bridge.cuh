#pragma once

// Optional, loopback-only HTTP bridge for the native CUDA body integrator.
// The web page opts in only after the user selects RTX Mode. This server does
// not expose a remote-network listener and never accepts arbitrary file paths
// or commands. Structural analysis and contact/failure decisions remain in JS.
#include <cuda_runtime.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  using FrameLabSocket = SOCKET;
  static constexpr FrameLabSocket kFrameLabInvalidSocket = INVALID_SOCKET;
  inline void frameLabCloseSocket(FrameLabSocket socket) { closesocket(socket); }
  inline bool frameLabStartSockets() {
    WSADATA data{};
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }
#else
  #include <arpa/inet.h>
  #include <netinet/in.h>
  #include <sys/socket.h>
  #include <unistd.h>
  using FrameLabSocket = int;
  static constexpr FrameLabSocket kFrameLabInvalidSocket = -1;
  inline void frameLabCloseSocket(FrameLabSocket socket) { ::close(socket); }
  inline bool frameLabStartSockets() { return true; }
#endif

namespace framelabs_rtx_bridge {

constexpr unsigned short kPort = 47652;
constexpr std::size_t kBodyStride = 13;
constexpr std::size_t kMaxRequestBytes = 64U * 1024U * 1024U;
constexpr std::size_t kMaxHeaderBytes = 32U * 1024U;
constexpr std::size_t kMaxBodies = 1000000U;

inline std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

inline std::string trim(const std::string& value) {
  const std::size_t first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const std::size_t last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

inline bool isAllowedOrigin(const std::string& origin) {
  if (origin.empty() || origin == "https://catxproductions.github.io") return true;
  if (origin == "http://localhost" || origin.rfind("http://localhost:", 0) == 0) return true;
  if (origin == "http://127.0.0.1" || origin.rfind("http://127.0.0.1:", 0) == 0) return true;
  return false;
}

inline bool sendAll(FrameLabSocket socket, const char* data, std::size_t size) {
  std::size_t sent = 0;
  while (sent < size) {
    const std::size_t remaining = size - sent;
    const int chunk = static_cast<int>(std::min<std::size_t>(remaining, 1024U * 1024U));
#ifdef _WIN32
    const int result = ::send(socket, data + sent, chunk, 0);
#else
    const int result = static_cast<int>(::send(socket, data + sent, static_cast<std::size_t>(chunk), 0));
#endif
    if (result <= 0) return false;
    sent += static_cast<std::size_t>(result);
  }
  return true;
}

inline std::string jsonEscape(const std::string& value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (unsigned char c : value) {
    switch (c) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (c < 0x20) result += ' ';
        else result += static_cast<char>(c);
    }
  }
  return result;
}

struct Request {
  std::string method;
  std::string path;
  std::map<std::string, std::string> headers;
  std::string body;
};

inline bool receiveMore(FrameLabSocket socket, std::string& buffer, std::size_t targetSize) {
  while (buffer.size() < targetSize) {
    char chunk[8192];
#ifdef _WIN32
    const int received = ::recv(socket, chunk, static_cast<int>(sizeof(chunk)), 0);
#else
    const int received = static_cast<int>(::recv(socket, chunk, sizeof(chunk), 0));
#endif
    if (received <= 0) return false;
    buffer.append(chunk, static_cast<std::size_t>(received));
    if (buffer.size() > kMaxRequestBytes + kMaxHeaderBytes) return false;
  }
  return true;
}

inline bool readRequest(FrameLabSocket socket, std::string& buffer, Request& request) {
  std::size_t separator = buffer.find("\r\n\r\n");
  while (separator == std::string::npos) {
    if (buffer.size() > kMaxHeaderBytes || !receiveMore(socket, buffer, buffer.size() + 1)) return false;
    separator = buffer.find("\r\n\r\n");
  }
  if (separator > kMaxHeaderBytes) return false;

  const std::string headerBlock = buffer.substr(0, separator);
  std::istringstream stream(headerBlock);
  std::string line;
  if (!std::getline(stream, line)) return false;
  if (!line.empty() && line.back() == '\r') line.pop_back();
  {
    std::istringstream startLine(line);
    std::string version;
    if (!(startLine >> request.method >> request.path >> version) || version.rfind("HTTP/", 0) != 0) return false;
  }
  request.headers.clear();
  while (std::getline(stream, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const std::size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    request.headers[lower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1));
  }

  std::size_t bodyLength = 0;
  const auto lengthIt = request.headers.find("content-length");
  if (lengthIt != request.headers.end()) {
    try {
      const unsigned long long parsed = std::stoull(lengthIt->second);
      if (parsed > kMaxRequestBytes) return false;
      bodyLength = static_cast<std::size_t>(parsed);
    } catch (...) { return false; }
  } else if (request.method == "POST") {
    return false;
  }

  const std::size_t bodyStart = separator + 4;
  if (bodyLength > kMaxRequestBytes || !receiveMore(socket, buffer, bodyStart + bodyLength)) return false;
  request.body.assign(buffer.data() + bodyStart, bodyLength);
  buffer.erase(0, bodyStart + bodyLength);
  return true;
}

inline std::string makeResponse(int code, const std::string& status,
                                const std::string& contentType,
                                const std::string& body,
                                const std::string& origin,
                                bool closeConnection = false) {
  std::ostringstream output;
  output << "HTTP/1.1 " << code << " " << status << "\r\n"
         << "Content-Type: " << contentType << "\r\n"
         << "Content-Length: " << body.size() << "\r\n"
         << "Cache-Control: no-store\r\n"
         << "X-Content-Type-Options: nosniff\r\n"
         << "Connection: " << (closeConnection ? "close" : "keep-alive") << "\r\n";
  if (!origin.empty() && isAllowedOrigin(origin)) {
    output << "Access-Control-Allow-Origin: " << origin << "\r\n"
           << "Vary: Origin\r\n";
  }
  output << "\r\n" << body;
  return output.str();
}

__global__ void integrateBodiesKernel(float* data, unsigned int count, float dt) {
  const unsigned int index = blockIdx.x * blockDim.x + threadIdx.x;
  if (index >= count) return;
  const unsigned int b = index * static_cast<unsigned int>(kBodyStride);
  const float maxVX = fmaxf(0.0f, data[b + 10]);
  const float maxVY = fmaxf(0.0f, data[b + 11]);
  const float maxOmega = fmaxf(0.0f, data[b + 12]);
  const float vx = fminf(maxVX, fmaxf(-maxVX, data[b + 2] + data[b + 4] * dt));
  const float vy = fminf(maxVY, fmaxf(-maxVY, data[b + 3] + data[b + 5] * dt));
  const float omegaStep = fminf(maxOmega, fmaxf(-maxOmega, data[b + 7] + data[b + 8] * dt));
  const float damping = fminf(1.0f, fmaxf(0.0f, data[b + 9]));
  const float omega = omegaStep * damping;

  data[b + 2] = vx;
  data[b + 3] = vy;
  data[b + 0] += vx * dt;
  data[b + 1] += vy * dt;
  data[b + 7] = omega;
  data[b + 6] += omega * dt;
}

class BodyIntegrator {
 public:
  BodyIntegrator() = default;
  BodyIntegrator(const BodyIntegrator&) = delete;
  BodyIntegrator& operator=(const BodyIntegrator&) = delete;
  ~BodyIntegrator() {
    if (deviceData_) cudaFree(deviceData_);
  }

  bool integrate(std::vector<float>& data, float dt, std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (data.empty()) return true;
    if (data.size() % kBodyStride != 0 || data.size() / kBodyStride > kMaxBodies) {
      error = "Invalid body batch size.";
      return false;
    }
    if (!std::isfinite(dt) || dt < 0.0f || dt > 0.05f) {
      error = "dt must be finite and between 0 and 0.05 seconds.";
      return false;
    }
    for (float value : data) {
      if (!std::isfinite(value)) {
        error = "Body batch contains a non-finite value.";
        return false;
      }
    }
    const std::size_t bytes = data.size() * sizeof(float);
    const cudaError_t selected = cudaSetDevice(0);
    if (selected != cudaSuccess) { error = cudaGetErrorString(selected); return false; }
    if (bytes > capacityBytes_) {
      float* replacement = nullptr;
      const cudaError_t allocated = cudaMalloc(reinterpret_cast<void**>(&replacement), bytes);
      if (allocated != cudaSuccess) { error = cudaGetErrorString(allocated); return false; }
      if (deviceData_) cudaFree(deviceData_);
      deviceData_ = replacement;
      capacityBytes_ = bytes;
    }
    cudaError_t status = cudaMemcpy(deviceData_, data.data(), bytes, cudaMemcpyHostToDevice);
    if (status != cudaSuccess) { error = cudaGetErrorString(status); return false; }
    const unsigned int count = static_cast<unsigned int>(data.size() / kBodyStride);
    integrateBodiesKernel<<<(count + 255U) / 256U, 256U>>>(deviceData_, count, dt);
    status = cudaGetLastError();
    if (status != cudaSuccess) { error = cudaGetErrorString(status); return false; }
    status = cudaDeviceSynchronize();
    if (status != cudaSuccess) { error = cudaGetErrorString(status); return false; }
    status = cudaMemcpy(data.data(), deviceData_, bytes, cudaMemcpyDeviceToHost);
    if (status != cudaSuccess) { error = cudaGetErrorString(status); return false; }
    return true;
  }

 private:
  float* deviceData_ = nullptr;
  std::size_t capacityBytes_ = 0;
  std::mutex mutex_;
};

inline bool parseDt(const std::string& text, float& dt) {
  if (text.empty()) return false;
  try {
    std::size_t consumed = 0;
    const float value = std::stof(text, &consumed);
    if (consumed != text.size() || !std::isfinite(value) || value < 0.0f || value > 0.05f) return false;
    dt = value;
    return true;
  } catch (...) { return false; }
}

inline void handleClient(FrameLabSocket client, BodyIntegrator& integrator,
                         const cudaDeviceProp& device, std::atomic<int>& activeClients) {
  std::string buffer;
  Request request;
  while (readRequest(client, buffer, request)) {
    const auto originIt = request.headers.find("origin");
    const std::string origin = originIt == request.headers.end() ? "" : originIt->second;
    const auto connectionIt = request.headers.find("connection");
    const bool closeConnection = connectionIt != request.headers.end() &&
                                 lower(connectionIt->second) == "close";

    std::string response;
    if (!isAllowedOrigin(origin)) {
      response = makeResponse(403, "Forbidden", "text/plain; charset=utf-8",
                              "Origin is not permitted by the local FrameLabs RTX bridge.\n", "", true);
    } else if (request.method == "OPTIONS") {
      std::ostringstream headers;
      headers << "HTTP/1.1 204 No Content\r\n"
              << "Content-Length: 0\r\n"
              << "Cache-Control: no-store\r\n"
              << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
              << "Access-Control-Allow-Headers: Content-Type, X-FrameLabs-Dt\r\n"
              << "Access-Control-Max-Age: 600\r\n"
              << "Connection: " << (closeConnection ? "close" : "keep-alive") << "\r\n";
      if (!origin.empty()) headers << "Access-Control-Allow-Origin: " << origin << "\r\nVary: Origin\r\n";
      headers << "\r\n";
      response = headers.str();
    } else if (request.method == "GET" && request.path == "/health") {
      std::ostringstream body;
      body << "{\"ok\":true,\"device\":\"" << jsonEscape(device.name)
           << "\",\"computeCapability\":\"" << device.major << "." << device.minor
           << "\",\"supports\":[\"body-integration\"],\"bind\":\"127.0.0.1:"
           << kPort << "\"}";
      response = makeResponse(200, "OK", "application/json; charset=utf-8",
                              body.str(), origin, closeConnection);
    } else if (request.method == "POST" && request.path == "/integrate") {
      const auto dtIt = request.headers.find("x-framelabs-dt");
      float dt = 0.0f;
      if (dtIt == request.headers.end() || !parseDt(dtIt->second, dt)) {
        response = makeResponse(400, "Bad Request", "text/plain; charset=utf-8",
                                "Missing or invalid X-FrameLabs-Dt header.\n", origin, closeConnection);
      } else if (request.body.empty() ||
                 request.body.size() % (kBodyStride * sizeof(float)) != 0 ||
                 request.body.size() > kMaxBodies * kBodyStride * sizeof(float)) {
        response = makeResponse(400, "Bad Request", "text/plain; charset=utf-8",
                                "Body must be packed Float32 state with 13 values per body (maximum one million bodies).\n",
                                origin, closeConnection);
      } else {
        std::vector<float> data(request.body.size() / sizeof(float));
        std::memcpy(data.data(), request.body.data(), request.body.size());
        std::string error;
        if (!integrator.integrate(data, dt, error)) {
          response = makeResponse(500, "CUDA Error", "text/plain; charset=utf-8",
                                  error + "\n", origin, closeConnection);
        } else {
          std::string output(data.size() * sizeof(float), '\0');
          std::memcpy(output.data(), data.data(), output.size());
          response = makeResponse(200, "OK", "application/octet-stream",
                                  output, origin, closeConnection);
        }
      }
    } else {
      response = makeResponse(404, "Not Found", "text/plain; charset=utf-8",
                              "Available endpoints: GET /health and POST /integrate.\n",
                              origin, closeConnection);
    }

    if (!sendAll(client, response.data(), response.size()) || closeConnection) break;
  }
  frameLabCloseSocket(client);
  activeClients.fetch_sub(1);
}

inline int runRTXBridgeServer() {
  int deviceCount = 0;
  cudaError_t status = cudaGetDeviceCount(&deviceCount);
  if (status != cudaSuccess) {
    std::cerr << "CUDA initialization failed: " << cudaGetErrorString(status) << "\n";
    return 2;
  }
  if (deviceCount < 1) {
    std::cerr << "No CUDA-capable NVIDIA GPU was found.\n";
    return 2;
  }
  cudaDeviceProp device{};
  status = cudaGetDeviceProperties(&device, 0);
  if (status != cudaSuccess) {
    std::cerr << "Could not inspect CUDA device: " << cudaGetErrorString(status) << "\n";
    return 2;
  }
  if (std::string(device.name).find("RTX") == std::string::npos || device.major < 7) {
    std::cerr << "RTX Mode requires a supported NVIDIA RTX GPU with CUDA support.\n"
              << "Detected: " << device.name << " (compute " << device.major << "."
              << device.minor << "). No server was started.\n";
    return 2;
  }
  status = cudaSetDevice(0);
  if (status != cudaSuccess) {
    std::cerr << "Could not select CUDA device: " << cudaGetErrorString(status) << "\n";
    return 2;
  }
  if (!frameLabStartSockets()) {
    std::cerr << "Could not initialize the local socket layer.\n";
    return 2;
  }

  FrameLabSocket listener = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == kFrameLabInvalidSocket) {
    std::cerr << "Could not create loopback listener.\n";
#ifdef _WIN32
    WSACleanup();
#endif
    return 2;
  }
  int reuse = 1;
#ifdef _WIN32
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse), sizeof(reuse));
#else
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
#endif

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(kPort);
  if (inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) != 1 ||
      ::bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      ::listen(listener, 8) != 0) {
    std::cerr << "Could not listen on 127.0.0.1:" << kPort
              << ". Another process may already be using the port.\n";
    frameLabCloseSocket(listener);
#ifdef _WIN32
    WSACleanup();
#endif
    return 2;
  }

  std::cout << "FrameLabs 2 RTX Mode local CUDA bridge\n"
            << "GPU: " << device.name << " (compute " << device.major << "."
            << device.minor << ")\n"
            << "Listening only on http://127.0.0.1:" << kPort << "\n"
            << "Allowed web origin: https://catxproductions.github.io\n"
            << "Open FrameLabs 2, choose RTX Mode, and approve loopback access if prompted.\n"
            << "Press Ctrl+C to stop the bridge.\n";

  BodyIntegrator integrator;
  std::atomic<int> activeClients{0};
  while (true) {
    FrameLabSocket client = ::accept(listener, nullptr, nullptr);
    if (client == kFrameLabInvalidSocket) continue;
    const int previous = activeClients.fetch_add(1);
    if (previous >= 4) {
      activeClients.fetch_sub(1);
      const std::string busy = makeResponse(503, "Service Unavailable",
        "text/plain; charset=utf-8", "The RTX bridge is busy; retry shortly.\n", "", true);
      sendAll(client, busy.data(), busy.size());
      frameLabCloseSocket(client);
      continue;
    }
    std::thread([client, &integrator, &device, &activeClients]() {
      handleClient(client, integrator, device, activeClients);
    }).detach();
  }
}
}  // namespace framelabs_rtx_bridge
