# Menggunakan image Python terbaru yang ringan
FROM python:3.9-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=7860

# Gunakan direktori /app sebagai working directory
WORKDIR /app

# Install dependencies sistem jika diperlukan sebelum modul Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy file requirements dan install dulu (agar dilokalisir di cache Docker)
COPY requirements.txt .

# Install dependencies Python
RUN pip install --no-cache-dir -r requirements.txt

# Create cache directory for gTTS mapping to huggingface volume properly (if needed)
ENV XDG_CACHE_HOME=/tmp/.cache
RUN mkdir -p /tmp/.cache && chmod 777 /tmp/.cache

# Copy seluruh file kode source (termasuk model dan HTML/JS backend) ke dalam container
COPY . .

# Berikan izin ke semua file (diperlukan oleh beberapa environments HuggingFace)
RUN chmod -R 777 /app

# Mengekspose port 7860 (Port wajib standar untuk Hugging Face Docker Spaces)
EXPOSE 7860

# Jalankan server uvicorn dan hubungkan ke app.py dengan port HF
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
