/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  reactStrictMode: true,
  generateEtags: false,
  webpack(config) {
    // src/ 模块遵守 Node ESM 惯例（以 .js 后缀引用 .ts 源）；让 webpack 解析到 TS 源文件（#839）。
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};
