const path = require('node:path');
const ts = require('typescript');

// Nest CLI's webpack defaults do not apply tsconfig.outDir to output.path.
// Read the selected project's tsconfig so build and start use the same folder.
module.exports = options => {
  const loader = options.module.rules
    .flatMap(rule => Array.isArray(rule.use) ? rule.use : [])
    .find(item => item.loader === 'ts-loader');
  const configPath = path.resolve(__dirname, loader.options.configFile);
  const source = ts.readConfigFile(configPath, ts.sys.readFile);
  if (source.error) throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(source.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: filename => filename,
      getCurrentDirectory: () => __dirname,
      getNewLine: () => '\n',
    }));
  }
  return {
    ...options,
    output: { ...options.output, path: parsed.options.outDir, filename: 'main.js' },
  };
};
