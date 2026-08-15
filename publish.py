import json
import os
import subprocess
import sys

def update_json_file(filepath, version):
    if not os.path.exists(filepath):
        print(f"[-] Warning: {filepath} not found.")
        return False
    
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    data['version'] = version
    
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)
        f.write('\n') # Add trailing newline standard in npm files
        
    print(f"[+] Updated version in {filepath} to {version}")
    return True

def main():
    print("=== Obsidian Plugin Publication Automation ===")
    
    # 1. Get current version from package.json if possible to display as hint
    current_version = "unknown"
    if os.path.exists("package.json"):
        try:
            with open("package.json", 'r', encoding='utf-8') as f:
                current_version = json.load(f).get("version", "unknown")
        except Exception:
            pass

    print(f"Current detected version: {current_version}")
    new_version = input("Enter new version number (e.g., 1.0.1): ").strip()
    
    if not new_version:
        print("[-] Error: Version cannot be empty.")
        sys.exit(1)
        
    print("\n--- Step 1: Updating Configuration Files ---")
    update_json_file("package.json", new_version)
    update_json_file("manifest.json", new_version)
    
    print("\n--- Step 2: Running npm install ---")
    result = subprocess.run(["npm", "install"], shell=True)
    if result.returncode != 0:
        print("[-] Error during 'npm install'. Aborting.")
        sys.exit(result.returncode)
        
    print("\n--- Step 3: Running npm run build ---")
    result = subprocess.run(["npm", "run", "build"], shell=True)
    if result.returncode != 0:
        print("[-] Error during 'npm run build'. Aborting.")
        sys.exit(result.returncode)
        
    print(f"\n[SUCCESS] Successfully bumped to v{new_version} and built plugin artifacts!")

if __name__ == "__main__":
    main()