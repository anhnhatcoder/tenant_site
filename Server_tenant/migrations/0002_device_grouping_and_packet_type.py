import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('Server_tenant', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='device',
            name='parent_device',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='paired_devices',
                to='Server_tenant.device',
                verbose_name='Thiết bị GPS liên kết / Nhóm cha'
            ),
        ),
        migrations.AddField(
            model_name='device',
            name='group_name',
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name='Tên nhóm / Đội thiết bị'),
        ),
        migrations.AddIndex(
            model_name='device',
            index=models.Index(fields=['parent_device'], name='device_parent_idx'),
        ),
        migrations.AddField(
            model_name='locationhistory',
            name='button_device',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='button_location_histories',
                to='Server_tenant.device',
                verbose_name='Nút nhấn liên kết phát tin'
            ),
        ),
        migrations.AddField(
            model_name='locationhistory',
            name='packet_type',
            field=models.CharField(default='PERIODIC', max_length=50, verbose_name='Phân loại gói tin (SOS / HEARTBEAT / PERIODIC)'),
        ),
        migrations.AddIndex(
            model_name='locationhistory',
            index=models.Index(fields=['device', 'is_sos_point'], name='lochist_sos_idx'),
        ),
    ]
