import { runMigrations } from '../infrastructure/migrations.js';
import { isDatabaseEnabled } from '../infrastructure/postgres.js';
async function main() {
    if (!isDatabaseEnabled()) {
        console.error('DATABASE_URL 未配置，无法执行 PostgreSQL 迁移。');
        process.exitCode = 1;
        return;
    }
    await runMigrations();
    console.log('数据库迁移已完成。');
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
