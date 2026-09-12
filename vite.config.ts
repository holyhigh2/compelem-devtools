import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'injected/index': resolve(__dirname, 'src/injected/index.ts'),
        'content/index': resolve(__dirname, 'src/content/index.ts'),
        'background/index': resolve(__dirname, 'src/background/index.ts'),
        'devtools/devtools': resolve(__dirname, 'src/devtools/devtools.ts'),
        'panel/panel': resolve(__dirname, 'src/panel/panel.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    },
    sourcemap: false,
    minify: false,
    target: 'es2020'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
