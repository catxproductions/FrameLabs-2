#include <vulkan/vulkan.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

static void check(VkResult r, const char* what) {
    if (r != VK_SUCCESS) throw std::runtime_error(std::string(what) + " failed: " + std::to_string(r));
}
static bool hasExtension(VkPhysicalDevice d, const char* name) {
    uint32_t n = 0;
    vkEnumerateDeviceExtensionProperties(d, nullptr, &n, nullptr);
    std::vector<VkExtensionProperties> e(n);
    vkEnumerateDeviceExtensionProperties(d, nullptr, &n, e.data());
    return std::any_of(e.begin(), e.end(), [&](const auto& x) { return std::strcmp(x.extensionName, name) == 0; });
}
struct HostBuffer {
    VkBuffer buffer{};
    VkDeviceMemory memory{};
    void* mapped{};
    VkDeviceSize bytes{};
};
int main() {
    VkInstance instance{};
    VkDevice device{};
    VkBuffer buffers[3]{};
    VkDeviceMemory memories[3]{};
    void* maps[3]{};
    VkDescriptorSetLayout setLayout{};
    VkPipelineLayout pipelineLayout{};
    VkPipeline pipeline{};
    VkDescriptorPool descriptorPool{};
    VkCommandPool commandPool{};
    VkFence fence{};
    try {
        VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
        app.pApplicationName = "FrameLabs cooperative-matrix validation";
        app.apiVersion = VK_API_VERSION_1_2;
        VkInstanceCreateInfo ici{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
        ici.pApplicationInfo = &app;
        check(vkCreateInstance(&ici, nullptr, &instance), "vkCreateInstance");

        uint32_t physicalCount = 0;
        check(vkEnumeratePhysicalDevices(instance, &physicalCount, nullptr), "enumerate physical devices");
        std::vector<VkPhysicalDevice> physicals(physicalCount);
        check(vkEnumeratePhysicalDevices(instance, &physicalCount, physicals.data()), "enumerate physical devices");

        VkPhysicalDevice physical{};
        VkPhysicalDeviceCooperativeMatrixFeaturesKHR coopFeature{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_COOPERATIVE_MATRIX_FEATURES_KHR};
        VkPhysicalDeviceShaderFloat16Int8Features float16Feature{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES};
        std::vector<VkCooperativeMatrixPropertiesKHR> supported;
        uint32_t queueFamily = 0;
        std::string gpuName;

        for (auto candidate : physicals) {
            VkPhysicalDeviceProperties properties{};
            vkGetPhysicalDeviceProperties(candidate, &properties);
            if (properties.vendorID != 0x10DE ||
                std::string(properties.deviceName).find("RTX") == std::string::npos) continue;
            if (!hasExtension(candidate, VK_KHR_COOPERATIVE_MATRIX_EXTENSION_NAME)) continue;

            VkPhysicalDeviceCooperativeMatrixFeaturesKHR cf{
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_COOPERATIVE_MATRIX_FEATURES_KHR};
            VkPhysicalDeviceShaderFloat16Int8Features ff{
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES};
            cf.pNext = &ff;
            VkPhysicalDeviceFeatures2 f2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
            f2.pNext = &cf;
            vkGetPhysicalDeviceFeatures2(candidate, &f2);
            if (!cf.cooperativeMatrix || !ff.shaderFloat16) continue;

            auto getProps = reinterpret_cast<PFN_vkGetPhysicalDeviceCooperativeMatrixPropertiesKHR>(
                vkGetInstanceProcAddr(instance, "vkGetPhysicalDeviceCooperativeMatrixPropertiesKHR"));
            if (!getProps) continue;
            uint32_t propCount = 0;
            if (getProps(candidate, &propCount, nullptr) != VK_SUCCESS || !propCount) continue;
            std::vector<VkCooperativeMatrixPropertiesKHR> props(propCount);
            for (auto& p : props) p.sType = VK_STRUCTURE_TYPE_COOPERATIVE_MATRIX_PROPERTIES_KHR;
            if (getProps(candidate, &propCount, props.data()) != VK_SUCCESS) continue;
            const bool hasShape = std::any_of(props.begin(), props.end(), [](const auto& p) {
                return p.MSize == 16 && p.KSize == 16 && p.NSize == 16 &&
                    p.scope == VK_SCOPE_SUBGROUP_KHR &&
                    p.AType == VK_COMPONENT_TYPE_FLOAT16_KHR &&
                    p.BType == VK_COMPONENT_TYPE_FLOAT16_KHR &&
                    p.CType == VK_COMPONENT_TYPE_FLOAT32_KHR &&
                    p.DType == VK_COMPONENT_TYPE_FLOAT32_KHR;
            });
            if (!hasShape) continue;

            uint32_t qCount = 0;
            vkGetPhysicalDeviceQueueFamilyProperties(candidate, &qCount, nullptr);
            std::vector<VkQueueFamilyProperties> queues(qCount);
            vkGetPhysicalDeviceQueueFamilyProperties(candidate, &qCount, queues.data());
            for (uint32_t q = 0; q < qCount; ++q) {
                if (queues[q].queueFlags & VK_QUEUE_COMPUTE_BIT) {
                    physical = candidate;
                    queueFamily = q;
                    gpuName = properties.deviceName;
                    coopFeature = cf;
                    float16Feature = ff;
                    supported = std::move(props);
                    break;
                }
            }
            if (physical) break;
        }
        if (!physical) throw std::runtime_error(
            "No NVIDIA RTX device exposes VK_KHR_cooperative_matrix with the required "
            "16x16x16 subgroup FP16xFP16-to-FP32 shape and shaderFloat16 feature.");

        float priority = 1.0f;
        VkDeviceQueueCreateInfo qci{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
        qci.queueFamilyIndex = queueFamily;
        qci.queueCount = 1;
        qci.pQueuePriorities = &priority;
        const char* extensions[] = {VK_KHR_COOPERATIVE_MATRIX_EXTENSION_NAME};
        coopFeature.pNext = &float16Feature;
        coopFeature.cooperativeMatrix = VK_TRUE;
        float16Feature.shaderFloat16 = VK_TRUE;
        VkDeviceCreateInfo dci{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
        dci.pNext = &coopFeature;
        dci.queueCreateInfoCount = 1;
        dci.pQueueCreateInfos = &qci;
        dci.enabledExtensionCount = 1;
        dci.ppEnabledExtensionNames = extensions;
        check(vkCreateDevice(physical, &dci, nullptr, &device), "vkCreateDevice");
        VkQueue queue{};
        vkGetDeviceQueue(device, queueFamily, 0, &queue);

        VkPhysicalDeviceMemoryProperties memoryProperties{};
        vkGetPhysicalDeviceMemoryProperties(physical, &memoryProperties);
        auto memoryType = [&](uint32_t bits) {
            for (uint32_t i = 0; i < memoryProperties.memoryTypeCount; ++i)
                if ((bits & (1u << i)) &&
                    (memoryProperties.memoryTypes[i].propertyFlags &
                     (VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)) ==
                     (VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)) return i;
            throw std::runtime_error("No host-visible coherent memory type for test buffers.");
        };
        const VkDeviceSize sizes[3] = {16 * 16 * sizeof(uint16_t), 16 * 16 * sizeof(uint16_t),
                                       16 * 16 * sizeof(float)};
        for (int i = 0; i < 3; ++i) {
            VkBufferCreateInfo bci{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
            bci.size = sizes[i];
            bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
            bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
            check(vkCreateBuffer(device, &bci, nullptr, &buffers[i]), "vkCreateBuffer");
            VkMemoryRequirements req{};
            vkGetBufferMemoryRequirements(device, buffers[i], &req);
            VkMemoryAllocateInfo mai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
            mai.allocationSize = req.size;
            mai.memoryTypeIndex = memoryType(req.memoryTypeBits);
            check(vkAllocateMemory(device, &mai, nullptr, &memories[i]), "vkAllocateMemory");
            check(vkBindBufferMemory(device, buffers[i], memories[i], 0), "vkBindBufferMemory");
            check(vkMapMemory(device, memories[i], 0, sizes[i], 0, &maps[i]), "vkMapMemory");
        }
        auto* a = static_cast<uint16_t*>(maps[0]);
        auto* b = static_cast<uint16_t*>(maps[1]);
        auto* c = static_cast<float*>(maps[2]);
        std::fill(a, a + 256, uint16_t(0x3c00)); // FP16 1.0
        std::fill(b, b + 256, uint16_t(0x4000)); // FP16 2.0
        std::fill(c, c + 256, 0.0f);

        VkDescriptorSetLayoutBinding bindings[3]{};
        for (uint32_t i = 0; i < 3; ++i) {
            bindings[i].binding = i;
            bindings[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            bindings[i].descriptorCount = 1;
            bindings[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
        }
        VkDescriptorSetLayoutCreateInfo slci{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
        slci.bindingCount = 3;
        slci.pBindings = bindings;
        check(vkCreateDescriptorSetLayout(device, &slci, nullptr, &setLayout), "descriptor set layout");
        VkPipelineLayoutCreateInfo plci{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
        plci.setLayoutCount = 1;
        plci.pSetLayouts = &setLayout;
        check(vkCreatePipelineLayout(device, &plci, nullptr, &pipelineLayout), "pipeline layout");

        std::ifstream shader(FRAMELABS_COOPMAT_SHADER_PATH, std::ios::binary | std::ios::ate);
        if (!shader) throw std::runtime_error("Cooperative-matrix SPIR-V file not found.");
        const auto shaderBytes = shader.tellg();
        if (shaderBytes <= 0 || shaderBytes % 4) throw std::runtime_error("Invalid cooperative-matrix SPIR-V.");
        std::vector<uint32_t> code(static_cast<size_t>(shaderBytes) / 4);
        shader.seekg(0);
        shader.read(reinterpret_cast<char*>(code.data()), shaderBytes);
        VkShaderModuleCreateInfo smci{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
        smci.codeSize = static_cast<size_t>(shaderBytes);
        smci.pCode = code.data();
        VkShaderModule module{};
        check(vkCreateShaderModule(device, &smci, nullptr, &module), "shader module");
        VkPipelineShaderStageCreateInfo stage{VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
        stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
        stage.module = module;
        stage.pName = "main";
        VkComputePipelineCreateInfo cpci{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
        cpci.stage = stage;
        cpci.layout = pipelineLayout;
        const VkResult pipelineResult = vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &cpci, nullptr, &pipeline);
        vkDestroyShaderModule(device, module, nullptr);
        check(pipelineResult, "cooperative-matrix compute pipeline");

        VkDescriptorPoolSize poolSize{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3};
        VkDescriptorPoolCreateInfo dpci{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
        dpci.maxSets = 1;
        dpci.poolSizeCount = 1;
        dpci.pPoolSizes = &poolSize;
        check(vkCreateDescriptorPool(device, &dpci, nullptr, &descriptorPool), "descriptor pool");
        VkDescriptorSetAllocateInfo dsai{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
        dsai.descriptorPool = descriptorPool;
        dsai.descriptorSetCount = 1;
        dsai.pSetLayouts = &setLayout;
        VkDescriptorSet set{};
        check(vkAllocateDescriptorSets(device, &dsai, &set), "descriptor set");
        VkDescriptorBufferInfo infos[3]{};
        VkWriteDescriptorSet writes[3]{};
        for (uint32_t i = 0; i < 3; ++i) {
            infos[i] = {buffers[i], 0, sizes[i]};
            writes[i] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
            writes[i].dstSet = set;
            writes[i].dstBinding = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            writes[i].pBufferInfo = &infos[i];
        }
        vkUpdateDescriptorSets(device, 3, writes, 0, nullptr);

        VkCommandPoolCreateInfo cpci2{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
        cpci2.queueFamilyIndex = queueFamily;
        check(vkCreateCommandPool(device, &cpci2, nullptr, &commandPool), "command pool");
        VkCommandBufferAllocateInfo cbai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
        cbai.commandPool = commandPool;
        cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cbai.commandBufferCount = 1;
        VkCommandBuffer command{};
        check(vkAllocateCommandBuffers(device, &cbai, &command), "command buffer");
        VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
        begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        check(vkBeginCommandBuffer(command, &begin), "begin command buffer");
        VkBufferMemoryBarrier pre[2]{};
        for (int i = 0; i < 2; ++i) {
            pre[i] = {VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER};
            pre[i].srcAccessMask = VK_ACCESS_HOST_WRITE_BIT;
            pre[i].dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
            pre[i].srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
            pre[i].dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
            pre[i].buffer = buffers[i];
            pre[i].size = VK_WHOLE_SIZE;
        }
        vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_HOST_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                             0, 0, nullptr, 2, pre, 0, nullptr);
        vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, pipelineLayout, 0, 1, &set, 0, nullptr);
        vkCmdDispatch(command, 1, 1, 1);
        VkBufferMemoryBarrier post{VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER};
        post.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
        post.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
        post.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        post.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        post.buffer = buffers[2];
        post.size = VK_WHOLE_SIZE;
        vkCmdPipelineBarrier(command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT,
                             0, 0, nullptr, 1, &post, 0, nullptr);
        check(vkEndCommandBuffer(command), "end command buffer");

        VkFenceCreateInfo fci{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
        check(vkCreateFence(device, &fci, nullptr, &fence), "fence");
        VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &command;
        check(vkQueueSubmit(queue, 1, &submit, fence), "queue submit");
        check(vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX), "wait for cooperative matrix");

        for (int i = 0; i < 256; ++i)
            if (std::fabs(c[i] - 32.0f) > 0.01f)
                throw std::runtime_error("GPU result validation failed at element " + std::to_string(i) +
                                         ": expected 32.0, got " + std::to_string(c[i]));
        std::cout << "PASS: Vulkan cooperative matrix operation executed and validated.\n"
                  << "GPU: " << gpuName << "\n"
                  << "Operation: FP16 16x16 x FP16 16x16 -> FP32 16x16 (subgroup scope)\n"
                  << "Validation: all 256 output values equal 32.0 within tolerance.\n";
    } catch (const std::exception& e) {
        std::cerr << "Cooperative-matrix validation failed: " << e.what() << "\n";
        if (device) vkDeviceWaitIdle(device);
        for (int i = 0; i < 3; ++i) {
            if (maps[i] && memories[i]) vkUnmapMemory(device, memories[i]);
            if (buffers[i]) vkDestroyBuffer(device, buffers[i], nullptr);
            if (memories[i]) vkFreeMemory(device, memories[i], nullptr);
        }
        if (fence) vkDestroyFence(device, fence, nullptr);
        if (commandPool) vkDestroyCommandPool(device, commandPool, nullptr);
        if (descriptorPool) vkDestroyDescriptorPool(device, descriptorPool, nullptr);
        if (pipeline) vkDestroyPipeline(device, pipeline, nullptr);
        if (pipelineLayout) vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
        if (setLayout) vkDestroyDescriptorSetLayout(device, setLayout, nullptr);
        if (device) vkDestroyDevice(device, nullptr);
        if (instance) vkDestroyInstance(instance, nullptr);
        return 1;
    }
    if (device) vkDeviceWaitIdle(device);
    for (int i = 0; i < 3; ++i) {
        if (maps[i] && memories[i]) vkUnmapMemory(device, memories[i]);
        if (buffers[i]) vkDestroyBuffer(device, buffers[i], nullptr);
        if (memories[i]) vkFreeMemory(device, memories[i], nullptr);
    }
    if (fence) vkDestroyFence(device, fence, nullptr);
    if (commandPool) vkDestroyCommandPool(device, commandPool, nullptr);
    if (descriptorPool) vkDestroyDescriptorPool(device, descriptorPool, nullptr);
    if (pipeline) vkDestroyPipeline(device, pipeline, nullptr);
    if (pipelineLayout) vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
    if (setLayout) vkDestroyDescriptorSetLayout(device, setLayout, nullptr);
    if (device) vkDestroyDevice(device, nullptr);
    if (instance) vkDestroyInstance(instance, nullptr);
    return 0;
}
