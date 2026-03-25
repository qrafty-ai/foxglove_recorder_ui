const path = require("path");

module.exports = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": path.resolve(__dirname, "./src"),
    };

    config.module.rules = config.module.rules.map((rule) => {
      if (rule.test?.toString() === /\.css$/i.toString()) {
        return {
          test: /\.css$/i,
          use: [
            "style-loader",
            "css-loader",
            {
              loader: "postcss-loader",
              options: {
                postcssOptions: {
                  plugins: [
                    ["@tailwindcss/postcss", {}],
                  ],
                },
              },
            },
          ],
        };
      }
      return rule;
    });
    return config;
  },
};
