import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5178,
    host: '0.0.0.0',
    allowedHosts: ['localhost', '127.0.0.1', '.trycloudflare.com', 'qianshousuanli.com', 'www.qianshousuanli.com'],
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    },
    proxy: {
      '/ea/': { target: 'https://www.qianshousuanli.com', changeOrigin: true },
      '/eco-v3/': { target: 'https://www.qianshousuanli.com', changeOrigin: true },
      '/api': {
        target: 'https://www.qianshousuanli.com',
        changeOrigin: true
      },
      '/ws': {
        target: 'wss://www.qianshousuanli.com',
        ws: true,
        changeOrigin: true
      },
      // 2026-06-19 · dev 代理到 dl CDN (edgecompute/releases/)
      '/downloads/latest': {
        target: 'https://www.qianshousuanli.com',
        changeOrigin: true,
        secure: true
      },
      // 2026-05-28 · OTA 二进制 endpoint 也接线上 · binary 仓库不在本地
      '/app': {
        target: 'https://www.qianshousuanli.com',
        changeOrigin: true,
        secure: true
      }
    }
  }
})
