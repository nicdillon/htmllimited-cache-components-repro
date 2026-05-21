import type { NextConfig } from 'next';

const config: NextConfig = {
  cacheComponents: true,
  htmlLimitedBots: /Googlebot|AhrefsBot|PerplexityBot/i,
};

export default config;
