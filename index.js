// UUID generation must see a cryptographically secure native RNG before any app code runs.
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import App from './src/app/Entry';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
