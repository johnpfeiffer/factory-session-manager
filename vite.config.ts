import { defineConfig } from 'vite';
import { factoryProxyPlugin } from './server/factoryProxy.ts';

export default defineConfig({
  // No environment values are made available as import.meta.env variables.
  envPrefix: [],
  plugins: [factoryProxyPlugin(process.env.FACTORY_API_KEY)],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        // MUI's React Server Component boundary has no effect in this client app.
        const modulePath = (warning.id ?? warning.loc?.file ?? '').replaceAll('\\', '/');
        const muiModule = /(?:^|\/)node_modules\/@mui\//.test(modulePath)
          || warning.message.includes('in "node_modules/@mui/');
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE'
          && warning.message.includes('module level directive "use client"') && muiModule) return;
        defaultHandler(warning);
      },
    },
  },
});
