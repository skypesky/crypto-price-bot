import { useEffect, useMemo, useState } from 'react';
import {
  Card, Table, Button, Space, App as AntApp, Tag, Drawer, Popconfirm, Tooltip, Empty,
  Row, Col, Typography, Input, Statistic, Modal,
} from 'antd';
import {
  ReloadOutlined, EyeOutlined, DeleteOutlined, ClearOutlined,
  SendOutlined, SearchOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { apiDelete, apiGet, apiPost, type Report } from '../api/client';

type Row = Report;

export function Reports() {
  const { message, modal } = AntApp.useApp();
  const [list, setList] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [keyword, setKeyword] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      setList(await apiGet<Row[]>('/api/reports?limit=100'));
      setSelectedKeys([]);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return list;
    return list.filter((r) =>
      String(r.id).includes(k) ||
      r.triggered_by.toLowerCase().includes(k) ||
      (r.message ? r.message.toLowerCase().includes(k) : false),
    );
  }, [list, keyword]);

  const stats = useMemo(() => {
    const total = list.length;
    const last24h = list.filter((r) => r.created_at > Date.now() - 86_400_000).length;
    const last = list[0] ?? null;
    const sent = list.reduce((acc, r) => acc + (r.tg_sent || r.feishu_sent ? 1 : 0), 0);
    const successRate = total > 0 ? Math.round((sent / total) * 100) : 0;
    return { total, last24h, last, successRate };
  }, [list]);

  const resend = async (r: Row, channels: Array<'tg' | 'feishu'>) => {
    const key = `${r.id}-${channels.join(',')}`;
    setResending(key);
    try {
      await apiPost(`/api/reports/${r.id}/resend`, { channels });
      message.success(`已重发到 ${channels.join(' + ')}`);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setResending(null);
    }
  };

  const removeOne = async (id: number) => {
    try {
      const res = await apiDelete<{ ok: boolean; deleted: number }>(`/api/reports/${id}`);
      message.success(`已删除 #${id}`);
      setSelectedKeys((prev) => prev.filter((k) => k !== id));
      void refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const removeSelected = async () => {
    if (selectedKeys.length === 0) return;
    try {
      const res = await apiPost<{ ok: boolean; deleted: number }>('/api/reports/delete-batch', { ids: selectedKeys.map((k) => Number(k)) });
      message.success(`已删除 ${res.deleted ?? selectedKeys.length} 条`);
      setSelectedKeys([]);
      void refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const clearAll = () => {
    if (list.length === 0) return;
    modal.confirm({
      title: `清空全部报表？`,
      content: `当前列表共 ${list.length} 条，但 DB 中可能更多。「清空全部」会删除数据库中所有报表，不只是当前页可见的 ${list.length} 条。此操作不可恢复。`,
      okText: '清空全部',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          // 用专门的 /clear endpoint 一次性清空（不受 ?limit=100 限制），
          // 否则只删 list 里那 100 条，剩下的「删了又长回来」会迷惑用户
          const res = await apiPost<{ ok: boolean; deleted: number }>('/api/reports/clear', {});
          message.success(`已清空 ${res.deleted ?? 0} 条`);
          setSelectedKeys([]);
          void refresh();
        } catch (err) {
          message.error((err as Error).message);
        }
      },
    });
  };

  const columns: ColumnsType<Row> = [
    { title: 'ID', dataIndex: 'id', width: 64, sorter: (a, b) => a.id - b.id, defaultSortOrder: 'descend' },
    {
      title: '时间', dataIndex: 'created_at', width: 170,
      sorter: (a, b) => a.created_at - b.created_at,
      render: (v: number) => (
        <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm:ss.SSS')}>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ant-color-text-secondary)' }}>
            {dayjs(v).format('MM-DD HH:mm:ss')}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '触发方式', dataIndex: 'triggered_by', width: 110,
      render: (v: string) => {
        const colorMap: Record<string, string> = { cron: 'blue', manual: 'default', test: 'purple', resend: 'orange' };
        return <Tag color={colorMap[v] ?? 'default'} style={{ margin: 0 }}>{v}</Tag>;
      },
    },
    {
      title: '成功 / 总数', width: 110,
      sorter: (a, b) => (a.success ? 1 : 0) - (b.success ? 1 : 0),
      render: (_, r) => {
        const ok = r.success ? 'green' : 'red';
        return (
          <Tag color={ok} style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
            {r.ok_coins} / {r.total_coins}
          </Tag>
        );
      },
    },
    {
      title: '推送', key: 'pushes', width: 130,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.tg_sent
            ? <Tag color="blue" style={{ margin: 0 }}>TG ✓</Tag>
            : <Tag style={{ margin: 0, opacity: 0.5 }}>TG —</Tag>}
          {r.feishu_sent
            ? <Tag color="cyan" style={{ margin: 0 }}>飞书 ✓</Tag>
            : <Tag style={{ margin: 0, opacity: 0.5 }}>飞书 —</Tag>}
        </Space>
      ),
    },
    {
      title: '消息预览', dataIndex: 'message', key: 'message',
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <span style={{ display: 'inline-block', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ant-color-text-secondary)' }}>
            {v.replace(/\n/g, ' ⏎ ')}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '操作', key: 'actions', width: 130, fixed: 'right',
      render: (_, r) => (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Tooltip title="查看详情">
            <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => setDetail(r)} aria-label={`查看 #${r.id}`} />
          </Tooltip>
          <Popconfirm
            title={`重发到 Telegram #${r.id}？`}
            okText="重发" cancelText="取消"
            disabled={!r.tg_sent}
            onConfirm={() => resend(r, ['tg'])}
          >
            <Button
              size="small" type="text" icon={<SendOutlined />}
              loading={resending === `${r.id}-tg`}
              disabled={!r.tg_sent}
              aria-label={`重发 TG #${r.id}`}
            />
          </Popconfirm>
          <Popconfirm
            title={`重发到飞书 #${r.id}？`}
            okText="重发" cancelText="取消"
            disabled={!r.feishu_sent}
            onConfirm={() => resend(r, ['feishu'])}
          >
            <Button
              size="small" type="text" icon={<ThunderboltOutlined />}
              loading={resending === `${r.id}-feishu`}
              disabled={!r.feishu_sent}
              aria-label={`重发飞书 #${r.id}`}
            />
          </Popconfirm>
          <Popconfirm
            title={`删除报表 #${r.id}？`}
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={() => removeOne(r.id)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除 #${r.id}`} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card variant="borderless">
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={24}>
            <Typography.Title level={4} style={{ margin: 0 }}>推送报表</Typography.Title>
            <Typography.Text type="secondary">最近的报表记录含完整推送消息，可重发或清理。表格按时间倒序。</Typography.Text>
          </Col>
          <Col xs={24} sm={12} md={6}><Statistic title="总报表" value={stats.total} suffix="条" /></Col>
          <Col xs={24} sm={12} md={6}><Statistic title="最近 24h" value={stats.last24h} suffix="条" valueStyle={{ color: 'var(--ant-color-primary)' }} /></Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="最近一次推送"
              value={stats.last ? dayjs(stats.last.created_at).format('MM-DD HH:mm') : '暂无'}
              suffix={stats.last ? `(${stats.last.triggered_by})` : undefined}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Statistic
              title="推送成功率"
              value={stats.successRate}
              suffix="%"
              valueStyle={{ color: stats.successRate >= 90 ? 'var(--ant-color-success)' : stats.successRate >= 60 ? 'var(--ant-color-warning)' : 'var(--ant-color-error)' }}
            />
          </Col>
        </Row>
      </Card>

      <Card
        variant="borderless"
        title={
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 'min(280px, 100%)' }}
          />
        }
        extra={
          <Space wrap size="small">
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新</Button>
            <Tooltip title={selectedKeys.length === 0 ? '先勾选要删除的报表' : ''}>
              <Button
                icon={<DeleteOutlined />}
                danger
                disabled={selectedKeys.length === 0}
                onClick={() => {
                  modal.confirm({
                    title: `删除选中的 ${selectedKeys.length} 条报表？`,
                    content: '此操作不可恢复。',
                    okText: `删除 ${selectedKeys.length} 条`,
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: removeSelected,
                  });
                }}
              >
                删除所选
              </Button>
            </Tooltip>
            <Tooltip title={list.length === 0 ? '当前已是空' : '清空当前列表中的所有报表'}>
              <Button icon={<ClearOutlined />} danger type="primary" ghost disabled={list.length === 0} onClick={clearAll}>
                清空全部
              </Button>
            </Tooltip>
          </Space>
        }
        bodyStyle={{ padding: 0 }}
      >
        <Table<Row>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          size="middle"
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          scroll={{ x: 900 }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
            preserveSelectedRowKeys: false,
          }}
          onRow={(r) => ({ onClick: () => setDetail(r), style: { cursor: 'pointer' } })}
          locale={{ emptyText: <Empty description={keyword ? '没有匹配的报表' : '暂无报表'} /> }}
        />
      </Card>

      <Drawer
        title={detail ? `报表 #${detail.id}` : ''}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={760}
      >
        {detail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={detail.success ? 'green' : 'red'}>{detail.ok_coins}/{detail.total_coins} 成功</Tag>
              <Tag color="blue">{detail.triggered_by}</Tag>
              {detail.tg_sent && <Tag color="blue">TG ✓</Tag>}
              {detail.feishu_sent && <Tag color="cyan">飞书 ✓</Tag>}
              <Typography.Text type="secondary">{dayjs(detail.created_at).format('YYYY-MM-DD HH:mm:ss')}</Typography.Text>
            </Space>
            <div>
              <Typography.Text type="secondary">消息内容</Typography.Text>
              <pre style={{
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 12, lineHeight: 1.6,
                background: 'var(--ant-color-fill-content)', padding: 16, borderRadius: 8,
                maxHeight: '60vh', overflow: 'auto',
              }}>
                {detail.message}
              </pre>
            </div>
          </Space>
        )}
      </Drawer>
    </Space>
  );
}

export default Reports;
