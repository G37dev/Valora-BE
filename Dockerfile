# Menggunakan image resmi Node.js versi LTS yang ringan (Alpine)
FROM node:20-alpine

# Tentukan direktori kerja di dalam container
WORKDIR /app

# Salin file package.json dan package-lock.json terlebih dahulu
COPY package*.json ./

# Install dependencies di dalam container
RUN npm install

# Salin seluruh sisa file kode proyek Anda ke dalam container
COPY . .

# Buka port aplikasi Express Anda (sesuaikan jika port aplikasi Anda bukan 3000)
EXPOSE 3000

# Perintah untuk menjalankan aplikasi Anda
CMD ["node", "index.js"]