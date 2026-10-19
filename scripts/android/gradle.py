#!/usr/bin/env python3
"""Run the Android wrapper with bounded resources and optional official RN sources."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-build', action='store_true')
    parser.add_argument('--bundle-debug', action='store_true')
    parser.add_argument('--architectures', default='arm64-v8a')
    parser.add_argument('--dependency-cache', type=Path, help='Directory containing boost-flat and optional icu/usr')
    args, tasks = parser.parse_known_args()
    if not set(args.architectures.split(',')) <= {'arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'}:
        parser.error('Unsupported Android architecture')
    env = os.environ.copy()
    env['PALMESH_REPOSITORY_ROOT'] = str(ROOT)
    # The retained cloud tool cache is optional; normal developer SDK variables
    # take precedence. No home directory, certificate or host-routing overrides.
    tools = Path(env.get('PALMESH_TOOLS_ROOT', '/workspace/.palmesh-tools'))
    if tools.is_dir():
        defaults = {'JAVA_HOME': tools / 'jdk-17', 'ANDROID_HOME': tools / 'android-sdk',
                    'ANDROID_USER_HOME': tools / 'android-cli-user', 'GRADLE_USER_HOME': tools / 'gradle'}
        for key, path in defaults.items():
            if path.is_dir(): env.setdefault(key, str(path))
    java_options = []
    for protocol in ('http', 'https'):
        value = env.get(protocol.upper() + '_PROXY')
        if not value: continue
        proxy = urlsplit(value)
        if proxy.username or proxy.password:
            parser.error('Authenticated proxy credentials must not be copied into JVM options')
        if proxy.hostname:
            java_options += [f'-D{protocol}.proxyHost={proxy.hostname}', f'-D{protocol}.proxyPort={proxy.port or 80}']
    system_trust = Path('/etc/ssl/certs/java/cacerts')
    if system_trust.is_file() and java_options:
        java_options.append('-Djavax.net.ssl.trustStore=' + str(system_trust))
    env['JAVA_OPTS'] = ' '.join([env.get('JAVA_OPTS', ''), *java_options]).strip()
    # JDK_JAVA_OPTIONS prints a launcher note to stderr. AGP's Prefab launcher
    # treats that output as a failure even when Java exits successfully. Bound
    # the Gradle daemon through org.gradle.jvmargs below instead.
    if env.get('JDK_JAVA_OPTIONS'):
        parser.error('Unset JDK_JAVA_OPTIONS for Android builds; AGP Prefab rejects the Java launcher note on stderr')
    init = []
    if args.source_build:
        dependency_cache = (args.dependency_cache or Path(env.get('PALMESH_SOURCE_CACHE', tools / 'source-deps' if tools.is_dir() else Path.home() / '.cache/palmesh/source-deps'))).expanduser().resolve()
        for key, path in {'REACT_NATIVE_BOOST_PATH': dependency_cache / 'boost-flat', 'ICU_ROOT': dependency_cache / 'icu/usr'}.items():
            if path.is_dir(): env.setdefault(key, str(path))
        if not env.get('REACT_NATIVE_BOOST_PATH') or not Path(env['REACT_NATIVE_BOOST_PATH']).is_dir():
            parser.error('Prepare Boost with scripts/android/prepare-boost.py, or set REACT_NATIVE_BOOST_PATH')
        env['REACT_NATIVE_BOOST_PATH'] = str(Path(env['REACT_NATIVE_BOOST_PATH']).expanduser().resolve())
        # Host ICU development headers/libraries may be installed by the system
        # package manager. A private prefix is optional, not a cloud requirement.
        if env.get('ICU_ROOT'):
            if not Path(env['ICU_ROOT']).is_dir(): parser.error('ICU_ROOT must name an existing ICU prefix')
            env['CMAKE_PREFIX_PATH'] = os.pathsep.join(filter(None, [env['ICU_ROOT'], env.get('CMAKE_PREFIX_PATH')]))
        env['CMAKE_BUILD_PARALLEL_LEVEL'] = '2'
        init += ['-I', str(ROOT / 'scripts/android/source-build.init.gradle'), '-I', str(ROOT / 'scripts/android/boost-source.init.gradle'),
                 '-I', str(ROOT / 'scripts/android/hermes-source.init.gradle')]
        if args.bundle_debug: env['PALMESH_BUNDLE_DEBUG'] = '1'
    elif args.bundle_debug:
        init += ['-I', str(ROOT / 'scripts/android/bundle-debug.init.gradle')]
    wrapper = 'gradlew.bat' if os.name == 'nt' else './gradlew'
    command = [wrapper, *(tasks or [':app:assembleDebug']), *init, '--no-daemon', '--max-workers=2', '--console=plain',
               '-PreactNativeArchitectures=' + args.architectures,
               '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:ActiveProcessorCount=2']
    return subprocess.call(command, cwd=ROOT / 'android', env=env)


if __name__ == '__main__':
    raise SystemExit(main())
