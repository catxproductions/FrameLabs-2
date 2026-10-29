#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
using Sock=SOCKET; const Sock BAD=INVALID_SOCKET; static void closeSock(Sock s){closesocket(s);}
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <csignal>
using Sock=int; const Sock BAD=-1; static void closeSock(Sock s){::close(s);}
#endif
#include <vulkan/vulkan.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <map>
#include <stdexcept>
static constexpr int PORT=47653; static constexpr size_t STRIDE=13, MAX_BYTES=64U*1024U*1024U;
static void ck(VkResult r,const char* s){if(r!=VK_SUCCESS)throw std::runtime_error(std::string(s)+" failed: "+std::to_string(r));}
static std::string trim(std::string s){auto a=s.find_first_not_of(" \t\r\n");if(a==s.npos)return {};auto b=s.find_last_not_of(" \t\r\n");return s.substr(a,b-a+1);}
static std::string low(std::string s){std::transform(s.begin(),s.end(),s.begin(),[](unsigned char c){return char(std::tolower(c));});return s;}
static bool originOK(const std::string&o){return o.empty()||o=="https://catxproductions.github.io"||o=="http://localhost"||o.rfind("http://localhost:",0)==0||o=="http://127.0.0.1"||o.rfind("http://127.0.0.1:",0)==0;}
static bool sendAll(Sock s,const std::string&x){size_t n=0;while(n<x.size()){
#ifdef _WIN32
int r=send(s,x.data()+n,int(std::min<size_t>(x.size()-n,1U<<20)),0);
#else
int r=int(send(s,x.data()+n,std::min<size_t>(x.size()-n,1U<<20),0));
#endif
if(r<=0)return false;n+=size_t(r);}return true;}
struct Req{std::string method,path,body;std::map<std::string,std::string> h;};
static bool readReq(Sock s,Req&q){std::string d;char b[8192];size_t p;while((p=d.find("\r\n\r\n"))==d.npos){
#ifdef _WIN32
int n=recv(s,b,sizeof(b),0);
#else
int n=int(recv(s,b,sizeof(b),0));
#endif
if(n<=0||d.size()+n>32768)return false;d.append(b,n);}
std::istringstream in(d.substr(0,p));std::string line,v;if(!std::getline(in,line))return false;{std::istringstream st(line);if(!(st>>q.method>>q.path>>v))return false;}
while(std::getline(in,line)){auto c=line.find(':');if(c!=line.npos)q.h[low(trim(line.substr(0,c)))]=trim(line.substr(c+1));}
size_t len=0;try{if(q.h.count("content-length"))len=std::stoull(q.h["content-length"]);}catch(...){return false;}if(len>MAX_BYTES)return false;size_t start=p+4;
while(d.size()-start<len){
#ifdef _WIN32
int n=recv(s,b,sizeof(b),0);
#else
int n=int(recv(s,b,sizeof(b),0));
#endif
if(n<=0)return false;d.append(b,n);if(d.size()>MAX_BYTES+32768)return false;}q.body.assign(d.data()+start,len);return true;}
static void reply(Sock s,int code,const std::string&status,const std::string&type,const std::string&body,const std::string&o){std::ostringstream h;h<<"HTTP/1.1 "<<code<<" "<<status<<"\r\nContent-Type: "<<type<<"\r\nContent-Length: "<<body.size()<<"\r\nCache-Control: no-store\r\nConnection: close\r\n";if(!o.empty()&&originOK(o))h<<"Access-Control-Allow-Origin: "<<o<<"\r\nVary: Origin\r\n";h<<"\r\n";sendAll(s,h.str()+body);}
class GPU{
public:
VkInstance inst{};VkPhysicalDevice phys{};VkDevice dev{};VkQueue queue{};uint32_t family{};VkBuffer buf{};VkDeviceMemory mem{};void*mapped{};VkDeviceSize cap{};VkDescriptorSetLayout dsl{};VkPipelineLayout pl{};VkPipeline pipe{};VkDescriptorPool dp{};VkDescriptorSet ds{};VkCommandPool cp{};VkCommandBuffer cmd{};VkFence fence{};std::string name;uint32_t api{};bool coop=false;
GPU(){
VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};app.pApplicationName="FrameLabs Vulkan RTX";app.apiVersion=VK_API_VERSION_1_1;VkInstanceCreateInfo ii{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};ii.pApplicationInfo=&app;ck(vkCreateInstance(&ii,nullptr,&inst),"instance");
uint32_t n=0;ck(vkEnumeratePhysicalDevices(inst,&n,nullptr),"enumerate");std::vector<VkPhysicalDevice> ds0(n);ck(vkEnumeratePhysicalDevices(inst,&n,ds0.data()),"enumerate");
for(auto d:ds0){VkPhysicalDeviceProperties p{};vkGetPhysicalDeviceProperties(d,&p);if(p.vendorID!=0x10DE||std::string(p.deviceName).find("RTX")==std::string::npos)continue;uint32_t qn=0;vkGetPhysicalDeviceQueueFamilyProperties(d,&qn,nullptr);std::vector<VkQueueFamilyProperties> qs(qn);vkGetPhysicalDeviceQueueFamilyProperties(d,&qn,qs.data());for(uint32_t i=0;i<qn;i++)if(qs[i].queueFlags&VK_QUEUE_COMPUTE_BIT){phys=d;family=i;name=p.deviceName;api=p.apiVersion;break;}if(phys)break;}
if(!phys)throw std::runtime_error("No NVIDIA RTX GPU with Vulkan compute support found.");uint32_t en=0;vkEnumerateDeviceExtensionProperties(phys,nullptr,&en,nullptr);std::vector<VkExtensionProperties> ex(en);vkEnumerateDeviceExtensionProperties(phys,nullptr,&en,ex.data());for(auto&e:ex)if(std::string(e.extensionName)=="VK_KHR_cooperative_matrix"||std::string(e.extensionName)=="VK_NV_cooperative_matrix2")coop=true;
float pr=1;VkDeviceQueueCreateInfo qi{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};qi.queueFamilyIndex=family;qi.queueCount=1;qi.pQueuePriorities=&pr;VkDeviceCreateInfo di{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};di.queueCreateInfoCount=1;di.pQueueCreateInfos=&qi;ck(vkCreateDevice(phys,&di,nullptr,&dev),"device");vkGetDeviceQueue(dev,family,0,&queue);
VkDescriptorSetLayoutBinding bind{};bind.binding=0;bind.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;bind.descriptorCount=1;bind.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT;VkDescriptorSetLayoutCreateInfo si{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};si.bindingCount=1;si.pBindings=&bind;ck(vkCreateDescriptorSetLayout(dev,&si,nullptr,&dsl),"descriptor layout");
VkPushConstantRange range{};range.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT;range.size=8;VkPipelineLayoutCreateInfo pli{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};pli.setLayoutCount=1;pli.pSetLayouts=&dsl;pli.pushConstantRangeCount=1;pli.pPushConstantRanges=&range;ck(vkCreatePipelineLayout(dev,&pli,nullptr,&pl),"pipeline layout");
std::ifstream f(FRAMELABS_SHADER_PATH,std::ios::binary|std::ios::ate);if(!f)throw std::runtime_error("Compiled SPIR-V shader not found.");auto sz=f.tellg();if(sz<=0||sz%4)throw std::runtime_error("Invalid SPIR-V file.");std::vector<uint32_t> code(size_t(sz)/4);f.seekg(0);f.read((char*)code.data(),sz);VkShaderModuleCreateInfo sm{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};sm.codeSize=size_t(sz);sm.pCode=code.data();VkShaderModule mod;ck(vkCreateShaderModule(dev,&sm,nullptr,&mod),"shader module");VkPipelineShaderStageCreateInfo stage{VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};stage.stage=VK_SHADER_STAGE_COMPUTE_BIT;stage.module=mod;stage.pName="main";VkComputePipelineCreateInfo pi{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};pi.stage=stage;pi.layout=pl;auto r=vkCreateComputePipelines(dev,VK_NULL_HANDLE,1,&pi,nullptr,&pipe);vkDestroyShaderModule(dev,mod,nullptr);ck(r,"compute pipeline");
VkDescriptorPoolSize ps{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,1};VkDescriptorPoolCreateInfo pci{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};pci.maxSets=1;pci.poolSizeCount=1;pci.pPoolSizes=&ps;ck(vkCreateDescriptorPool(dev,&pci,nullptr,&dp),"descriptor pool");VkDescriptorSetAllocateInfo dai{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};dai.descriptorPool=dp;dai.descriptorSetCount=1;dai.pSetLayouts=&dsl;ck(vkAllocateDescriptorSets(dev,&dai,&ds),"descriptor set");
VkCommandPoolCreateInfo cpi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};cpi.queueFamilyIndex=family;cpi.flags=VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;ck(vkCreateCommandPool(dev,&cpi,nullptr,&cp),"command pool");VkCommandBufferAllocateInfo cai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};cai.commandPool=cp;cai.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;cai.commandBufferCount=1;ck(vkAllocateCommandBuffers(dev,&cai,&cmd),"command buffer");VkFenceCreateInfo fi{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};ck(vkCreateFence(dev,&fi,nullptr,&fence),"fence");
}
~GPU(){if(dev)vkDeviceWaitIdle(dev);if(mapped)vkUnmapMemory(dev,mem);if(buf)vkDestroyBuffer(dev,buf,nullptr);if(mem)vkFreeMemory(dev,mem,nullptr);if(fence)vkDestroyFence(dev,fence,nullptr);if(cp)vkDestroyCommandPool(dev,cp,nullptr);if(pipe)vkDestroyPipeline(dev,pipe,nullptr);if(dp)vkDestroyDescriptorPool(dev,dp,nullptr);if(pl)vkDestroyPipelineLayout(dev,pl,nullptr);if(dsl)vkDestroyDescriptorSetLayout(dev,dsl,nullptr);if(dev)vkDestroyDevice(dev,nullptr);if(inst)vkDestroyInstance(inst,nullptr);}
uint32_t memType(uint32_t bits){VkPhysicalDeviceMemoryProperties p{};vkGetPhysicalDeviceMemoryProperties(phys,&p);for(uint32_t i=0;i<p.memoryTypeCount;i++)if((bits&(1U<<i))&&(p.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT)&&(p.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_HOST_COHERENT_BIT))return i;throw std::runtime_error("No host-visible coherent buffer memory.");}
void reserve(VkDeviceSize bytes){if(buf&&cap>=bytes)return;if(mapped)vkUnmapMemory(dev,mem);if(buf)vkDestroyBuffer(dev,buf,nullptr);if(mem)vkFreeMemory(dev,mem,nullptr);buf={};mem={};mapped=nullptr;cap=0;VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};bi.size=bytes;bi.usage=VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;bi.sharingMode=VK_SHARING_MODE_EXCLUSIVE;ck(vkCreateBuffer(dev,&bi,nullptr,&buf),"buffer");VkMemoryRequirements mr{};vkGetBufferMemoryRequirements(dev,buf,&mr);VkMemoryAllocateInfo ai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};ai.allocationSize=mr.size;ai.memoryTypeIndex=memType(mr.memoryTypeBits);ck(vkAllocateMemory(dev,&ai,nullptr,&mem),"memory");ck(vkBindBufferMemory(dev,buf,mem,0),"bind");ck(vkMapMemory(dev,mem,0,bytes,0,&mapped),"map");cap=bytes;VkDescriptorBufferInfo db{buf,0,bytes};VkWriteDescriptorSet wr{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};wr.dstSet=ds;wr.dstBinding=0;wr.descriptorCount=1;wr.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;wr.pBufferInfo=&db;vkUpdateDescriptorSets(dev,1,&wr,0,nullptr);}
void run(std::vector<float>&a,float dt){if(a.empty())return;if(a.size()%STRIDE||a.size()/STRIDE>1000000||!std::isfinite(dt)||dt<0||dt>0.05f)throw std::runtime_error("Invalid body batch or timestep.");for(float x:a)if(!std::isfinite(x))throw std::runtime_error("Non-finite body state.");VkDeviceSize bytes=a.size()*4;reserve(bytes);memcpy(mapped,a.data(),size_t(bytes));ck(vkResetFences(dev,1,&fence),"reset fence");ck(vkResetCommandBuffer(cmd,0),"reset command");VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};bi.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;ck(vkBeginCommandBuffer(cmd,&bi),"begin");VkBufferMemoryBarrier pre{VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER};pre.srcAccessMask=VK_ACCESS_HOST_WRITE_BIT;pre.dstAccessMask=VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT;pre.srcQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;pre.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;pre.buffer=buf;pre.size=bytes;vkCmdPipelineBarrier(cmd,VK_PIPELINE_STAGE_HOST_BIT,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,0,nullptr,1,&pre,0,nullptr);vkCmdBindPipeline(cmd,VK_PIPELINE_BIND_POINT_COMPUTE,pipe);vkCmdBindDescriptorSets(cmd,VK_PIPELINE_BIND_POINT_COMPUTE,pl,0,1,&ds,0,nullptr);struct P{uint32_t count;float dt;}p{uint32_t(a.size()/STRIDE),dt};vkCmdPushConstants(cmd,pl,VK_SHADER_STAGE_COMPUTE_BIT,0,8,&p);vkCmdDispatch(cmd,(p.count+255)/256,1,1);VkBufferMemoryBarrier post{VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER};post.srcAccessMask=VK_ACCESS_SHADER_WRITE_BIT;post.dstAccessMask=VK_ACCESS_HOST_READ_BIT;post.srcQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;post.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;post.buffer=buf;post.size=bytes;vkCmdPipelineBarrier(cmd,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_HOST_BIT,0,0,nullptr,1,&post,0,nullptr);ck(vkEndCommandBuffer(cmd),"end");VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};si.commandBufferCount=1;si.pCommandBuffers=&cmd;ck(vkQueueSubmit(queue,1,&si,fence),"submit");ck(vkWaitForFences(dev,1,&fence,VK_TRUE,UINT64_MAX),"wait");memcpy(a.data(),mapped,size_t(bytes));for(float x:a)if(!std::isfinite(x))throw std::runtime_error("Invalid Vulkan output.");}
};
static std::string ver(uint32_t v){return std::to_string(VK_VERSION_MAJOR(v))+"."+std::to_string(VK_VERSION_MINOR(v))+"."+std::to_string(VK_VERSION_PATCH(v));}
int main(){
#ifndef _WIN32
signal(SIGPIPE,SIG_IGN);
#else
WSADATA w{};if(WSAStartup(MAKEWORD(2,2),&w)!=0)return 2;
#endif
try{GPU gpu;Sock server=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(server==BAD)throw std::runtime_error("Socket creation failed.");int yes=1;
#ifdef _WIN32
setsockopt(server,SOL_SOCKET,SO_REUSEADDR,(const char*)&yes,sizeof(yes));
#else
setsockopt(server,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));
#endif
sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(PORT);inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);if(bind(server,(sockaddr*)&a,sizeof(a))||listen(server,8)){closeSock(server);throw std::runtime_error("Cannot bind 127.0.0.1:47653; port may be in use.");}
std::cout<<"FrameLabs Vulkan RTX helper\nGPU: "<<gpu.name<<"\nVulkan: "<<ver(gpu.api)<<"\nCooperative matrix extension: "<<(gpu.coop?"detected (not used by body kernel)":"not exposed")<<"\nListening only on http://127.0.0.1:47653\n";
for(;;){Sock c=accept(server,nullptr,nullptr);if(c==BAD)continue;Req q;if(!readReq(c,q)){closeSock(c);continue;}std::string o=q.h.count("origin")?q.h["origin"]:"";
if(!originOK(o))reply(c,403,"Forbidden","text/plain","Origin denied.\n","");
else if(q.method=="OPTIONS"){std::string h="HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-FrameLabs-Dt\r\nAccess-Control-Max-Age: 600\r\n";if(!o.empty())h+="Access-Control-Allow-Origin: "+o+"\r\nVary: Origin\r\n";h+="Connection: close\r\n\r\n";sendAll(c,h);}
else if(q.method=="GET"&&q.path=="/health"){std::string body="{\"ok\":true,\"device\":\""+gpu.name+"\",\"apiVersion\":\""+ver(gpu.api)+"\",\"cooperativeMatrix\":"+(gpu.coop?"true":"false")+",\"tensorCoreStatus\":\""+(gpu.coop?"cooperative-matrix-extension-detected-not-used-by-body-kernel":"not-exposed-by-driver")+"\",\"supports\":[\"body-integration\"]}";reply(c,200,"OK","application/json",body,o);}
else if(q.method=="POST"&&q.path=="/integrate"){float dt=-1;try{if(q.h.count("x-framelabs-dt"))dt=std::stof(q.h["x-framelabs-dt"]);}catch(...){}if(q.body.empty()||q.body.size()%(STRIDE*4)||q.body.size()>MAX_BYTES||!std::isfinite(dt)||dt<0||dt>0.05f)reply(c,400,"Bad Request","text/plain","Invalid body state or timestep.\n",o);else try{std::vector<float>x(q.body.size()/4);memcpy(x.data(),q.body.data(),q.body.size());gpu.run(x,dt);std::string out(x.size()*4,'\0');memcpy(out.data(),x.data(),out.size());reply(c,200,"OK","application/octet-stream",out,o);}catch(const std::exception&e){reply(c,500,"Vulkan Error","text/plain",std::string(e.what())+"\n",o);}}
else reply(c,404,"Not Found","text/plain","Use GET /health or POST /integrate.\n",o);closeSock(c);}
}catch(const std::exception&e){std::cerr<<"Vulkan RTX helper: "<<e.what()<<"\n";return 2;}return 0;}
