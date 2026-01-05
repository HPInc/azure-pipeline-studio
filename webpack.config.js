const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
    target: 'node',
    entry: './extension.js',
    output: {
        path: path.resolve(__dirname, './'),
        filename: 'extension-bundle.js',
        libraryTarget: 'commonjs2',
        library: {
            type: 'commonjs2',
        },
    },
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                terserOptions: {
                    keep_classnames: true,
                    keep_fnames: true,
                    mangle: {
                        reserved: ['runCli', 'expandPipelineFromString', 'AzurePipelineParser'],
                    },
                },
            }),
        ],
    },
    plugins: [
        new webpack.BannerPlugin({
            banner: '#!/usr/bin/env node',
            raw: true,
            entryOnly: true,
        }),
    ],
    externals: {
        vscode: 'commonjs vscode',
    },
    node: {
        __dirname: false,
        __filename: false,
    },
    resolve: {
        extensions: ['.js', '.mjs'],
        preferRelative: true,
        fallback: {
            fs: false,
        },
        modules: ['node_modules'],
    },
    module: {
        rules: [
            {
                test: /\.mjs$/,
                include: /node_modules/,
                type: 'javascript/auto',
            },
        ],
    },
};
