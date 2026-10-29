cmake_minimum_required(VERSION 3.24)
project(FrameLabsRTXMode LANGUAGES CXX CUDA)

# RTX 4060 / Ada Lovelace is compute capability 8.9.
# Override with -DCMAKE_CUDA_ARCHITECTURES=... for other NVIDIA GPUs.
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set(CMAKE_CUDA_ARCHITECTURES 89)
endif()

add_executable(framelabs_rtx_mode tensor_core_mode.cu)
target_compile_features(framelabs_rtx_mode PRIVATE cxx_std_17)
set_target_properties(framelabs_rtx_mode PROPERTIES
  CUDA_STANDARD 17
  CUDA_STANDARD_REQUIRED YES
  CUDA_ARCHITECTURES "${CMAKE_CUDA_ARCHITECTURES}"
)
