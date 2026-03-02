import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, '..');
  const modeEnv = loadEnv(mode, envDir, '');
  const devEnv = loadEnv('dev', envDir, '');
  const env = { ...devEnv, ...modeEnv };
  const apiProxyTarget = env['VITE_API_PROXY_TARGET'] || 'http://localhost:3000';

  return {
    envDir,
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
