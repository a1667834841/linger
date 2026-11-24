// Noble's key generation reads crypto.getRandomValues, which React Native
// does not provide; the polyfill must load before any module that uses it.
import "react-native-get-random-values";
import "expo-router/entry";
