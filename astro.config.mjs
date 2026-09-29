// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// On GitHub Pages the site lives under /<repo-name>/ — the deploy workflow sets BASE_PATH.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  vite: { plugins: [tailwindcss()] },
});
