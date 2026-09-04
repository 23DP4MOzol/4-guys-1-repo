#!/usr/bin/env sh

set -eu

port="${PORT:-10000}"

sed -ri "s/Listen [0-9]+/Listen ${port}/" /etc/apache2/ports.conf
sed -ri "s/<VirtualHost \*:[0-9]+>/<VirtualHost *:${port}>/" /etc/apache2/sites-enabled/000-default.conf

php artisan config:cache

exec apache2-foreground
