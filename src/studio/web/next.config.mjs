/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  reactStrictMode: true,
  generateEtags: false,
  // The host owns page identity (including a missing trailing segment), before Next renders it.
  skipTrailingSlashRedirect: true,
  // Keep the public address (including workspace) while the host renders a pre-stream failure.
  // This route is private to Next: the HTTP adapter does not mount it directly.
  async rewrites() {
    return { beforeFiles: [{ source: '/:path*', has: [{ type: 'header', key: 'x-omk-studio-page-fault', value: '1' }], destination: '/studio-fault' }] };
  },
  webpack(config) {
    // src/ 模块遵守 Node ESM 惯例（以 .js 后缀引用 .ts 源）；让 webpack 解析到 TS 源文件（#839）。
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};
