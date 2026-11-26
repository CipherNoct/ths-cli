const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    // 测试默认只走 Bridge 桩，禁止真实直连网络（数据源降级逻辑用注入 stub 单独测）
    env: { THS_DATA_SOURCE: 'bridge' },
  },
});
