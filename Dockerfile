FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y ffmpeg fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
