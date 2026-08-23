import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    // Both are load bearing, whatever the old comment here implied. The React
    // plugin provides the JSX transform every .tsx file in src/ depends on, and
    // the Tailwind plugin is what resolves `@import 'tailwindcss'` at the top of
    // src/styles/tailwind.css. Removing either breaks the build immediately.
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Kept as a convention for new code even though nothing imports through
      // it yet. tsconfig.json declares the same mapping; change both together.
      '@': path.resolve(__dirname, './src'),
    },
  },
})
