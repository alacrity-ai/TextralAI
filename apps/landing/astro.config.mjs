import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://textral.alacrity.ai',
  trailingSlash: 'never',
  build: {
    inlineStylesheets: 'auto',
  },
  integrations: [tailwind({ applyBaseStyles: false })],
});
