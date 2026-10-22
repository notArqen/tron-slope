import { defineConfig } from 'vite';

// relative asset paths so the build works under any sub-path (GitHub Pages serves /tron-slope/)
export default defineConfig({ base: './' });
