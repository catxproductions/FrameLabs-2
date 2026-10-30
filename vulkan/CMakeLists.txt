cmake_minimum_required(VERSION 3.24)
project(FrameLabsVulkanRTX LANGUAGES CXX)
find_package(Vulkan REQUIRED)
find_program(FRAMELABS_GLSLC glslc HINTS "$ENV{VULKAN_SDK}/Bin" "$ENV{VULKAN_SDK}/bin")
if(NOT FRAMELABS_GLSLC)
  message(FATAL_ERROR "glslc not found. Install Vulkan SDK and add it to PATH.")
endif()

set(SHADER "${CMAKE_CURRENT_BINARY_DIR}/body_integrate.spv")
add_custom_command(
  OUTPUT "${SHADER}"
  COMMAND "${FRAMELABS_GLSLC}" --target-env=vulkan1.2
          "${CMAKE_CURRENT_SOURCE_DIR}/body_integrate.comp" -o "${SHADER}"
  DEPENDS body_integrate.comp
  VERBATIM
)
add_custom_target(vulkan_shader DEPENDS "${SHADER}")
add_executable(framelabs_vulkan_rtx_mode vulkan_bridge.cpp)
add_dependencies(framelabs_vulkan_rtx_mode vulkan_shader)
target_link_libraries(framelabs_vulkan_rtx_mode PRIVATE Vulkan::Vulkan)
target_compile_features(framelabs_vulkan_rtx_mode PRIVATE cxx_std_17)
target_compile_definitions(framelabs_vulkan_rtx_mode PRIVATE FRAMELABS_SHADER_PATH="${SHADER}")

# Separate, real cooperative-matrix dispatch test. Not yet wired into live physics.
set(COOPMAT_SHADER "${CMAKE_CURRENT_BINARY_DIR}/coopmat_multiply.spv")
add_custom_command(
  OUTPUT "${COOPMAT_SHADER}"
  COMMAND "${FRAMELABS_GLSLC}" --target-env=vulkan1.2
          "${CMAKE_CURRENT_SOURCE_DIR}/coopmat_multiply.comp" -o "${COOPMAT_SHADER}"
  DEPENDS coopmat_multiply.comp
  VERBATIM
)
add_executable(framelabs_coopmat_probe coopmat_probe.cpp)
add_custom_target(vulkan_coopmat_shader DEPENDS "${COOPMAT_SHADER}")
add_dependencies(framelabs_coopmat_probe vulkan_coopmat_shader)
target_link_libraries(framelabs_coopmat_probe PRIVATE Vulkan::Vulkan)
target_compile_features(framelabs_coopmat_probe PRIVATE cxx_std_17)
target_compile_definitions(framelabs_coopmat_probe PRIVATE FRAMELABS_COOPMAT_SHADER_PATH="${COOPMAT_SHADER}")

if(WIN32)
  target_link_libraries(framelabs_vulkan_rtx_mode PRIVATE ws2_32)
  target_link_libraries(framelabs_coopmat_probe PRIVATE ws2_32)
endif()
