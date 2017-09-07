module.exports = {
  input: "./src/history.js",
  output: {format: "cjs", file: "dist/history.js"},
  sourcemap: true,
  plugins: [require("rollup-plugin-buble")()],
  external(id) { return !/^[\.\/]/.test(id) }
}
