FROM node:20-alpine
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm install

COPY packages/shared packages/shared
COPY apps/web apps/web

WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["npm", "run", "dev"]
