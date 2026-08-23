const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Treat TFLite models as assets so the pose model can be `require`d and swapped
// at runtime without a native rebuild (react-native-fast-tflite installation
// step 2). Without this Metro tries to parse the binary as JavaScript.
config.resolver.assetExts.push('tflite');

module.exports = config;
