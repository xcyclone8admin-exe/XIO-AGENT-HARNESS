import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@xyra/ui', '@xyra/mod-core', '@xyra/mod-ops', '@xyra/contracts', '@xyra/sdk'],
};
export default config;
