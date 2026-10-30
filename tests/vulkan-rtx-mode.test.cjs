'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('Vulkan RTX Mode is separate from CUDA and has a real cooperative-matrix validation dispatch', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const backend = read('js/compute-backends.js');
  const cuda = read('cuda/CMakeLists.txt');
  const vulkanCmake = read('vulkan/CMakeLists.txt');
  const bridge = read('vulkan/vulkan_bridge.cpp');
  const bodyShader = read('vulkan/body_integrate.comp');
  const coopShader = read('vulkan/coopmat_multiply.comp');
  const probe = read('vulkan/coopmat_probe.cpp');
  const docs = read('vulkan/README.md');

  assert.match(html, /<option value="rtx">RTX Mode · Native CUDA helper<\/option>/);
  assert.match(html, /<option value="vulkan-rtx">Vulkan RTX Mode · Native Vulkan helper<\/option>/);
  assert.match(main, /VULKAN RTX MODE — HARDWARE WARNING/);
  assert.match(main, /connectVulkanRTX/);
  assert.match(main, /framelabs:vulkan-rtx-lost/);
  assert.match(backend, /127\.0\.0\.1:47653/);
  assert.match(backend, /physicsMode === 'vulkan-rtx'/);
  assert.match(backend, /connectVulkanRTX/);
  assert.match(cuda, /LANGUAGES CXX CUDA/);
  assert.match(vulkanCmake, /LANGUAGES CXX/);
  assert.doesNotMatch(vulkanCmake, /CUDA|nvcc/i);
  assert.match(bridge, /127\.0\.0\.1/);
  assert.match(bridge, /VK_KHR_cooperative_matrix/);
  assert.match(bridge, /"\/health"/);
  assert.match(bridge, /"\/integrate"/);
  assert.match(bodyShader, /local_size_x=256/);
  assert.match(bodyShader, /bodies\.v\[b\+2u\]/);

  assert.match(vulkanCmake, /framelabs_coopmat_probe/);
  assert.match(vulkanCmake, /coopmat_multiply\.comp/);
  assert.match(coopShader, /GL_KHR_cooperative_matrix/);
  assert.match(coopShader, /coopMatMulAdd/);
  assert.match(coopShader, /gl_MatrixUseAccumulator/);
  assert.match(probe, /vkGetPhysicalDeviceCooperativeMatrixPropertiesKHR/);
  assert.match(probe, /VK_COMPONENT_TYPE_FLOAT16_KHR/);
  assert.match(probe, /vkCmdDispatch/);
  assert.match(probe, /expected 32\.0/);
  assert.match(docs, /genuine cooperative-matrix dispatch/i);
  assert.match(docs, /not yet part of live FrameLabs structural physics/i);
});
