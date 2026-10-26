package com.palmesh.runtime;

import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Android Keystore protects a nonexportable wrapping key. Signing seeds and
 * SQLCipher secrets are authenticated-encrypted records in no-backup storage.
 * Lost/invalidated keys and damaged records fail closed; neither condition may
 * silently replace a device identity or downgrade to plaintext persistence. */
public final class PalMeshSecurityModule extends ReactContextBaseJavaModule {
    private static final Object VAULT_LOCK = new Object();
    private static final int MAGIC = 0x504D5631;
    private static final int MAX_VALUE_BYTES = 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final SecureRandom random = new SecureRandom();
    private final File directory;
    private final String alias;

    PalMeshSecurityModule(ReactApplicationContext context) {
        super(context);
        directory = new File(context.getNoBackupFilesDir(), "palmesh-vault-v1");
        alias = context.getPackageName() + ".palmesh.vault.v1";
    }

    @Override public String getName() { return "PalMeshSecurity"; }

    @ReactMethod public void read(String key, Promise promise) {
        execute(promise, () -> {
            try {
                validateKey(key);
                synchronized (VAULT_LOCK) {
                    SecretKey master = masterKey();
                    AtomicFile record = new AtomicFile(recordFile(key));
                    if (!hasRecord(record)) { promise.resolve(null); return; }
                    byte[] plaintext = decrypt(record, key, master);
                    try { promise.resolve(new String(plaintext, StandardCharsets.UTF_8)); }
                    finally { Arrays.fill(plaintext, (byte) 0); }
                }
            } catch (Exception failure) {
                promise.reject("SECURE_VAULT_UNAVAILABLE", "Secure record could not be opened. Existing keys were not replaced.", failure);
            }
        });
    }

    @ReactMethod public void write(String key, String value, Promise promise) {
        execute(promise, () -> {
            byte[] plaintext = null;
            try {
                validateKey(key);
                if (value == null) throw new IllegalArgumentException("Secure value is required");
                plaintext = value.getBytes(StandardCharsets.UTF_8);
                if (plaintext.length > MAX_VALUE_BYTES) throw new IllegalArgumentException("Secure value is too large");
                synchronized (VAULT_LOCK) {
                    SecretKey master = masterKey();
                    AtomicFile record = new AtomicFile(recordFile(key));
                    if (hasRecord(record)) {
                        // Refuse to overwrite corrupt data, even when a caller
                        // accidentally retries provisioning after a failed read.
                        byte[] previous = decrypt(record, key, master);
                        Arrays.fill(previous, (byte) 0);
                    }
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.ENCRYPT_MODE, master);
                    cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
                    byte[] encrypted = cipher.doFinal(plaintext);
                    byte[] iv = cipher.getIV();
                    if (iv.length != 12) throw new IllegalStateException("Unexpected GCM nonce length");
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    try (DataOutputStream stream = new DataOutputStream(buffer)) {
                        stream.writeInt(MAGIC);
                        stream.write(iv);
                        stream.write(encrypted);
                    }
                    FileOutputStream output = null;
                    try {
                        output = record.startWrite();
                        output.write(buffer.toByteArray());
                        // AtomicFile synchronizes data and safely restores the
                        // preceding record if a write fails or the process dies.
                        record.finishWrite(output);
                        output = null;
                    } finally { if (output != null) record.failWrite(output); }
                    promise.resolve(null);
                }
            } catch (Exception failure) {
                promise.reject("SECURE_VAULT_UNAVAILABLE", "Secure record could not be saved. Plaintext storage is disabled.", failure);
            } finally { if (plaintext != null) Arrays.fill(plaintext, (byte) 0); }
        });
    }

    @ReactMethod public void randomBytes(double count, Promise promise) {
        if (!Double.isFinite(count) || count != Math.floor(count) || count < 1 || count > 4096) {
            promise.reject("INVALID_RANDOM_LENGTH", "Random length must be an integer from 1 to 4096"); return;
        }
        execute(promise, () -> {
            byte[] bytes = new byte[(int) count];
            try {
                random.nextBytes(bytes);
                promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP));
            } catch (RuntimeException failure) { promise.reject("RANDOM_UNAVAILABLE", "Secure random source is unavailable", failure); }
            finally { Arrays.fill(bytes, (byte) 0); }
        });
    }

    private byte[] decrypt(AtomicFile record, String key, SecretKey master) throws Exception {
        if (record.getBaseFile().length() > MAX_VALUE_BYTES + 32L) throw new IllegalStateException("Invalid vault record size");
        try (FileInputStream input = record.openRead(); DataInputStream data = new DataInputStream(input)) {
            if (data.readInt() != MAGIC) throw new IllegalStateException("Unsupported vault record");
            byte[] iv = new byte[12];
            data.readFully(iv);
            ByteArrayOutputStream encryptedBuffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int length;
            while ((length = data.read(chunk)) != -1) {
                encryptedBuffer.write(chunk, 0, length);
                if (encryptedBuffer.size() > MAX_VALUE_BYTES + 16) throw new IllegalStateException("Invalid vault ciphertext size");
            }
            byte[] encrypted = encryptedBuffer.toByteArray();
            if (encrypted.length < 16 || encrypted.length > MAX_VALUE_BYTES + 16) throw new IllegalStateException("Invalid vault ciphertext");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, master, new GCMParameterSpec(128, iv));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(encrypted);
        }
    }

    private SecretKey masterKey() throws Exception {
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Secure directory is unavailable");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) {
            java.security.Key key = store.getKey(alias, null);
            if (!(key instanceof SecretKey)) throw new IllegalStateException("Invalid Keystore master key");
            return (SecretKey) key;
        }
        File[] existing = directory.listFiles();
        if (existing == null || existing.length > 0) {
            throw new IllegalStateException("Keystore master key is missing for existing secure records");
        }
        boolean strongBox = Build.VERSION.SDK_INT >= 28
            && getReactApplicationContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
        try { return generateMaster(strongBox); }
        catch (java.security.ProviderException unsupported) {
            // Some devices advertise StrongBox but cannot allocate a key. The
            // regular AndroidKeyStore remains nonexportable and may use a TEE.
            if (!strongBox) throw unsupported;
            return generateMaster(false);
        }
    }

    private SecretKey generateMaster(boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true);
        if (Build.VERSION.SDK_INT >= 28 && strongBox) spec.setIsStrongBoxBacked(true);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(spec.build());
        return generator.generateKey();
    }

    private File recordFile(String key) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : digest) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return new File(directory, name + ".vault");
    }

    private static boolean hasRecord(AtomicFile record) {
        File file = record.getBaseFile();
        // Android restores a prior .bak record in openRead(). A leftover .new
        // without a committed predecessor is also treated as existing data,
        // so an interrupted first write never permits silent reprovisioning.
        return file.exists() || new File(file.getPath() + ".bak").exists()
            || new File(file.getPath() + ".new").exists();
    }

    private static void validateKey(String key) {
        if (key == null || !key.matches("[A-Za-z0-9._:-]{1,128}")) throw new IllegalArgumentException("Invalid secure key name");
    }

    private void execute(Promise promise, Runnable operation) {
        try { worker.execute(operation); }
        catch (java.util.concurrent.RejectedExecutionException closed) {
            promise.reject("SECURE_VAULT_CLOSED", "Secure vault is closed", closed);
        }
    }

    @Override public void invalidate() {
        worker.shutdown();
        super.invalidate();
    }
}
