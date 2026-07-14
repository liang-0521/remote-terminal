use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::PathBuf};

fn required_path(name: &str) -> PathBuf {
    let value = env::var_os(name).unwrap_or_else(|| panic!("missing required environment variable {name}"));
    let path = PathBuf::from(value);
    assert!(path.is_file(), "{name} does not point to a file: {}", path.display());
    path
}

#[test]
#[ignore = "release workflow supplies an installer, decoded signature, and public key"]
fn verify_external_update_signature() {
    let installer_path = required_path("REMOTE_TERMINAL_UPDATE_INSTALLER");
    let signature_path = required_path("REMOTE_TERMINAL_UPDATE_SIGNATURE");
    let public_key_path = required_path("REMOTE_TERMINAL_UPDATE_PUBLIC_KEY");

    let installer = fs::read(&installer_path).expect("read updater installer");
    let signature = Signature::from_file(&signature_path).expect("decode updater signature");
    let public_key = PublicKey::from_file(&public_key_path).expect("decode updater public key");

    public_key
        .verify(&installer, &signature, false)
        .expect("updater installer signature must match the configured public key");
}
