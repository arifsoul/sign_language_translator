import os
import shutil

def migrate():
    dataset_dir = 'bisindo_dataset'
    if not os.path.exists(dataset_dir):
        print("Dataset dir not found.")
        return

    # Create subfolders for A-Z and 0-9
    labels = [chr(i) for i in range(ord('A'), ord('Z') + 1)] + [str(i) for i in range(10)]
    for label in labels:
        folder_path = os.path.join(dataset_dir, label)
        if not os.path.exists(folder_path):
            os.makedirs(folder_path)
            print(f"Created: {folder_path}")

    # Move existing files
    files = os.listdir(dataset_dir)
    for f in files:
        if os.path.isdir(os.path.join(dataset_dir, f)):
            continue
            
        full_path = os.path.join(dataset_dir, f)
        label = None
        
        # Pattern 1: Huruf_A.png -> label A
        if f.startswith('Huruf_'):
            label = f.replace('Huruf_', '').split('.')[0].split('_')[0].upper()
        # Pattern 2: 1.png -> label 1
        else:
            label = f.split('.')[0].split('_')[0].upper()

        if label:
            target_folder = os.path.join(dataset_dir, label)
            if os.path.exists(target_folder):
                try:
                    shutil.move(full_path, os.path.join(target_folder, f))
                    print(f"Moved: {f} -> {label}/")
                except Exception as e:
                    print(f"Error moving {f}: {e}")
            else:
                print(f"Skipping {f}, label {label} folder not found.")

if __name__ == "__main__":
    migrate()
