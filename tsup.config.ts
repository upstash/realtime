import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/client", "src/server"],
  format: ["cjs", "esm"],
  splitting: false,
  clean: true,
  bundle: false,
  dts: true,
  treeshake: true,
  minify: false,
  sourcemap: false,
})
