module.exports = {
  entry: "./src/history.js",
  dest: "dist/history.js",
  format: "cjs",
  sourceMap: true,
  plugins: [require("rollup-plugin-buble")()],
  external(id) { return !/^[\.\/]/.test(id) }
}
