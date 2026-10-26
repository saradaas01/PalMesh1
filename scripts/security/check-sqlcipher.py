#!/usr/bin/env python3
"""Exercise the shipped SQLCipher source on Linux, without printing any keys.

Requires a C compiler and OpenSSL development files. This tests the actual
amalgamation's encryption/decryption and corrupt-key behavior; Android/iOS VFS,
Keystore/Keychain and device operation still require their own device tests.
"""
from __future__ import annotations
import ctypes
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    source = ROOT / 'node_modules/@op-engineering/op-sqlite/cpp/sqlcipher/sqlite3.c'
    if not source.is_file():
        raise SystemExit('Run npm ci before the SQLCipher source check.')
    with tempfile.TemporaryDirectory(prefix='palmesh-sqlcipher-check-') as temporary:
        directory = Path(temporary)
        library = directory / 'libsqlcipher-probe.so'
        subprocess.run([
            os.environ.get('CC', 'cc'), '-shared', '-fPIC', '-O1', '-D_GNU_SOURCE',
            '-DSQLITE_HAS_CODEC', '-DSQLCIPHER_CRYPTO_OPENSSL', '-DSQLITE_TEMP_STORE=2',
            '-DSQLITE_THREADSAFE=1', '-DSQLITE_OMIT_LOAD_EXTENSION',
            '-DSQLITE_EXTRA_INIT=sqlcipher_extra_init',
            '-DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown',
            str(source), '-o', str(library), '-lcrypto', '-lpthread', '-ldl', '-lm',
        ], check=True)
        sql = ctypes.CDLL(str(library))
        sql.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        sql.sqlite3_key_v2.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_int]
        sql.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        sql.sqlite3_close.argtypes = [ctypes.c_void_p]
        database = directory / 'encrypted.sqlite'
        key = os.urandom(32).hex().encode('ascii')

        def opened(secret: bytes) -> ctypes.c_void_p:
            connection = ctypes.c_void_p()
            if sql.sqlite3_open(os.fsencode(database), ctypes.byref(connection)) != 0:
                raise RuntimeError('SQLCipher could not open the probe file.')
            if sql.sqlite3_key_v2(connection, b'main', secret, len(secret)) != 0:
                sql.sqlite3_close(connection)
                raise RuntimeError('SQLCipher could not set the probe key.')
            return connection

        connection = opened(key)
        try:
            assert sql.sqlite3_exec(connection, b'CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES (\'PalMesh encryption probe\');', None, None, None) == 0
        finally:
            sql.sqlite3_close(connection)
        contents = database.read_bytes()
        assert not contents.startswith(b'SQLite format 3'), 'Plaintext SQLite header found.'
        assert b'PalMesh encryption probe' not in contents, 'Plaintext payload found.'
        connection = opened(key)
        try:
            assert sql.sqlite3_exec(connection, b'SELECT value FROM probe', None, None, None) == 0
        finally:
            sql.sqlite3_close(connection)
        connection = opened(os.urandom(32).hex().encode('ascii'))
        try:
            assert sql.sqlite3_exec(connection, b'SELECT value FROM probe', None, None, None) != 0, 'Wrong key opened the database.'
        finally:
            sql.sqlite3_close(connection)
        try:
            with sqlite3.connect(database) as plaintext:
                plaintext.execute('SELECT value FROM probe').fetchall()
        except sqlite3.DatabaseError:
            pass
        else:
            raise AssertionError('Plain SQLite read the encrypted database.')
        print('PASS: real SQLCipher encrypted file, correct-key reopen, wrong-key rejection, plaintext-reader rejection.')
        print('SQLCipher source SHA256:', hashlib.sha256(source.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
