#!/bin/bash
set -e

echo "🚀 Deploying OMNIDESK..."

cd /opt/omnidesk

# 1. Сохраняем .env
cp .env /tmp/.env.backup

# 2. Забираем изменения
git fetch origin
git checkout project-review-and-error-identification
git pull origin project-review-and-error-identification

# 3. Применяем миграции
export DATABASE_URL="postgresql://omnidesk:omni_S3cret_2026@localhost:5432/omnidesk"
for f in scripts/*.sql; do
    echo "Applying $f"
    psql "$DATABASE_URL" -f "$f"
done

# 4. Восстанавливаем .env
cp /tmp/.env.backup .env

# 5. Пересобираем
rm -rf .next
pnpm install
pnpm build

# 6. Перезапускаем
pm2 restart all --update-env
pm2 status

echo "✅ Deploy complete!"
