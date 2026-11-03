const fs = require('fs')
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')

const rootPath = process.cwd()
const distPath = path.join(rootPath, 'dist')
const srcPath = path.join(rootPath, 'src')

// AR needs a secure context (HTTPS or localhost). Plain http://<LAN-IP> blocks motion/orientation on mobile Safari.
const devServerUseHttps = process.env.WEBPACK_SERVE_HTTP !== '1'
// iPhone + self-signed HTTPS: the dev-server client often cannot open wss://…/ws (TLS), which spams the console. Disable with WEBPACK_SERVE_NO_CLIENT=1 (see npm run serve:phone).
const devServerNoClient = process.env.WEBPACK_SERVE_NO_CLIENT === '1'
const devServerKey = path.join(rootPath, 'localhost-key.pem')
const devServerCert = path.join(rootPath, 'localhost.pem')
const devServerHasCustomCert =
  fs.existsSync(devServerKey) && fs.existsSync(devServerCert)

const ATTRIBUTES_TO_EXPAND = [
  'src', 'gltf-model', 'cover-image-url', 'footer-image-url', 'watermark-image-url',
]

const makeJsLoader = () => ({
  test: /\.js$/,
  include: [srcPath],
  use: {
    loader: 'babel-loader',
    options: {
      presets: ['@babel/preset-env'],
      plugins: ['@babel/plugin-transform-runtime'],
    },
  },
  exclude: [/node_modules/, path.join(rootPath, 'external')],
})

const makeTsLoader = () => ({
  test: /\.ts$/,
  loader: 'ts-loader',
  exclude: /node_modules/,
})

const makeCssLoader = () => ({
  test: /\.css$/,
  exclude: /\/assets\//,
  use: ['style-loader', 'css-loader'],
})

const makeSassLoader = () => ({
  test: /\.scss$/,
  use: ['style-loader', 'css-loader', 'sass-loader'],
})

const makeAssetLoader = () => ({
  test: /\..*$/,
  include: [path.join(srcPath, 'assets')],
  loader: path.join(__dirname, 'asset-loader.js'),
})

const indexHtmlPath = path.join(srcPath, 'index.html')

const makeDefaultHtmlLoader = () => ({
  test: /\.html$/,
  exclude: indexHtmlPath,
  use: {
    loader: 'html-loader',
    options: {
      esModule: false,
      sources: {
        list: [
          {
            tag: 'script',
            attribute: 'src',
            type: 'src',
            filter: () => false,
          },
          ...ATTRIBUTES_TO_EXPAND.map((attr) => ({
            tag: '*',
            attribute: attr,
            type: 'src',
            filter: (t, a, attrs) => {
              const v = attrs[a]
              if (typeof v !== 'string') return true
              // Vendor SDK: static copy, not bundled
              if (v.includes('external/') || v.startsWith('../external')) return false
              // Binary media: CopyWebpackPlugin; do not parse as modules (avoids LFS pointer issues in html child compile)
              if (/\.(glb|gltf|mp4|webm|mov|bin|jpe?g|png|webp|svg)(\?.*)?$/i.test(v))
                return false
              return true
            },
          })),
        ],
      },
    },
  },
})

const config = {
  // Use project root as context and a relative entry. With context: srcPath + absolute entry,
  // webpack resolves the entry incorrectly (see path concatenation under .../src/Users/...).
  context: rootPath,
  entry: './src/app.js',
  output: {
    filename: 'bundle.js',
    path: distPath,
    publicPath: '',  // relative: works at / (dev server) and under /<repo>/ (GitHub Pages)
  },
  plugins: [
    new HtmlWebpackPlugin({
      templateContent: () => fs.readFileSync(indexHtmlPath, 'utf8'),
      filename: 'index.html',
      inject: false,
      scriptLoading: 'defer',
      minify: false,
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.join(rootPath, 'external'),
          to: path.join(distPath, 'external'),
          noErrorOnMissing: true,
        },
        {
          from: path.join(srcPath, 'assets'),
          to: path.join(distPath, 'assets'),
          noErrorOnMissing: true,
        },
        {
          from: path.join(srcPath, 'targets'),
          to: path.join(distPath, 'targets'),
          noErrorOnMissing: true,
          globOptions: { ignore: ['**/*.js'] },
        },
        {
          from: path.join(rootPath, 'image-targets'),
          to: path.join(distPath, 'image-targets'),
          noErrorOnMissing: true,
        },
        {
          from: path.join(rootPath, 'public'),
          to: distPath,
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
  resolve: {extensions: ['.ts', '.js']},
  module: {
    rules: [
      makeJsLoader(),
      makeTsLoader(),
      makeCssLoader(),
      makeSassLoader(),
      makeAssetLoader(),
      makeDefaultHtmlLoader(),
    ],
  },
  mode: 'production',
  // CopyWebpackPlugin emits vendor JS under external/; do not run Terser on those files (Git LFS pointers break minify).
  optimization: { minimize: false },
  devServer: {
    host: '0.0.0.0',
    allowedHosts: 'all',
    open: false,
    compress: true,
    hot: !devServerNoClient,
    liveReload: false,
    ...(devServerUseHttps
      ? {
          server: devServerHasCustomCert
            ? {
                type: 'https',
                options: {
                  key: fs.readFileSync(devServerKey),
                  cert: fs.readFileSync(devServerCert),
                },
              }
            : 'https',
        }
      : {}),
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
    },
    ...(devServerNoClient
      ? { client: false }
      : {
          client: {
            webSocketURL: 'auto://0.0.0.0:0/ws',
            overlay: {
              warnings: false,
              errors: true,
            },
          },
        }),
  },
}

module.exports = config
