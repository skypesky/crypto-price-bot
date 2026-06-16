import { useEffect, useState } from 'react';
import { Table, Button, Drawer, Tag, Space, App as AntApp, Popconfirm } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { apiGet, apiPost, type Report } from '../api/client';

export function Reports() {
  const { message } = AntApp.useApp();
  const [list, setList] = useState<Report[]>([]);
  const [detail, setDetail] = useState<Report | null>(null);
  const [resending, setResending] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setList(await apiGet<Report[]>('/api/reports?limit=100'));
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const resend = async (id: number, channels: Array<'tg' | 'feishu'>) => {
    const key = `${id}-${channels.join(',')}`;
    setResending(key);
    try {
      await apiPost(`/api/reports/${id}/resend`, { channels });
      message.success(`已重发到 ${channels.join(' + ')}`);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setResending(null);
    }
  };

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
      </Space>
      <Table<Report>
        rowKey="id"
        dataSource={list}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 60 },
          { title: '触发方式', dataIndex: 'triggered_by', width: 90, render: (v) => <Tag>{v}</Tag> },
          {
            title: '成功/总数', width: 100,
            render: (_, r) => (
              <Tag color={r.success ? 'green' : 'red'}>{r.ok_coins}/{r.total_coins}</Tag>
            ),
          },
          { title: 'TG', dataIndex: 'tg_sent', width: 60, render: (v) => v ? <Tag color="blue">✓</Tag> : <Tag>✗</Tag> },
          { title: '飞书', dataIndex: 'feishu_sent', width: 60, render: (v) => v ? <Tag color="cyan">✓</Tag> : <Tag>✗</Tag> },
          { title: '时间', dataIndex: 'created_at', render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
          {
            title: '操作',
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => setDetail(r)}>查看</Button>
                <Popconfirm title="重发到 Telegram？" onConfirm={() => resend(r.id, ['tg'])}>
                  <Button size="small" loading={resending === `${r.id}-tg`} disabled={!r.tg_sent}>重发 TG</Button>
                </Popconfirm>
                <Popconfirm title="重发到飞书？" onConfirm={() => resend(r.id, ['feishu'])}>
                  <Button size="small" loading={resending === `${r.id}-feishu`} disabled={!r.feishu_sent}>重发飞书</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Drawer
        title={detail ? `报表 #${detail.id}` : ''}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={720}
      >
        {detail && (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 12 }}>
            {detail.message}
          </pre>
        )}
      </Drawer>
    </>
  );
}