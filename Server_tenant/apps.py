from django.apps import AppConfig
import logging

logger = logging.getLogger(__name__)


class ServerTenantConfig(AppConfig):
    name = 'Server_tenant'

    def ready(self):
        # 1. Chạy migrate tự động
        try:
            from django.core.management import call_command
            call_command('migrate', interactive=False)
            logger.info("[ServerTenantConfig] Auto migrate completed.")
        except Exception as e:
            logger.warning(f"[ServerTenantConfig] Auto migrate failed: {e}")

        # 2. Đảm bảo DDL bổ sung trực tiếp nếu migrate bị nghẽn
        try:
            from django.db import connection
            with connection.cursor() as cursor:
                # Bảng Device: Thêm parent_device_id và group_name
                for tbl in ('"Server_tenant_device"', 'server_tenant_device', 'Server_tenant_device'):
                    try:
                        cursor.execute(f'''
                            ALTER TABLE {tbl} 
                            ADD COLUMN IF NOT EXISTS parent_device_id bigint 
                            REFERENCES {tbl}(id) ON DELETE SET NULL;
                        ''')
                        cursor.execute(f'''
                            ALTER TABLE {tbl} 
                            ADD COLUMN IF NOT EXISTS group_name varchar(255);
                        ''')
                        break
                    except Exception:
                        pass

                # Bảng LocationHistory: Thêm button_device_id và packet_type
                for tbl_lh, tbl_dev in (
                    ('"Server_tenant_locationhistory"', '"Server_tenant_device"'),
                    ('server_tenant_locationhistory', 'server_tenant_device'),
                    ('Server_tenant_locationhistory', 'Server_tenant_device')
                ):
                    try:
                        cursor.execute(f'''
                            ALTER TABLE {tbl_lh} 
                            ADD COLUMN IF NOT EXISTS button_device_id bigint 
                            REFERENCES {tbl_dev}(id) ON DELETE SET NULL;
                        ''')
                        cursor.execute(f'''
                            ALTER TABLE {tbl_lh} 
                            ADD COLUMN IF NOT EXISTS packet_type varchar(50) DEFAULT 'PERIODIC';
                        ''')
                        break
                    except Exception:
                        pass

                # 3. Dọn dẹp triệt để các điểm SOS ảo trước đây do nhầm lẫn gói tin định kỳ/heartbeat của LW006
                for tbl_lh, tbl_dev in (
                    ('"Server_tenant_locationhistory"', '"Server_tenant_device"'),
                    ('server_tenant_locationhistory', 'server_tenant_device'),
                    ('Server_tenant_locationhistory', 'Server_tenant_device')
                ):
                    try:
                        cursor.execute(f'''
                            UPDATE {tbl_lh} 
                            SET is_sos_point = FALSE 
                            WHERE is_sos_point = TRUE 
                              AND device_id IN (
                                  SELECT id FROM {tbl_dev} 
                                  WHERE LOWER(device_name) LIKE '%lw006%' OR LOWER(dev_eui) LIKE '%c819c6d0%'
                              );
                        ''')
                        break
                    except Exception:
                        pass
            logger.info("[ServerTenantConfig] Database schema & cleanup check passed.")
        except Exception as e:
            logger.warning(f"[ServerTenantConfig] ready init error: {e}")
