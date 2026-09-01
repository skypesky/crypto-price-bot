import { useEffect, useMemo, useState } from 'react';
import {
  Card, Table, Button, Switch, Modal, Form, Input, InputNumber, Popconfirm, App as AntApp,
  Space, Tag, Tooltip, Empty, Statistic, Row, Col, Typography,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, HolderOutlined,
  ArrowUpOutlined, ArrowDownOutlined, BellOutlined, BellFilled,
} from '@ant-design/icons';
import { DndContext, type DragEndEvent, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ColumnsType } from 'antd/es/table';
import { apiDelete, apiGet, apiPost, apiPut, type Coin } from '../api/client';

interface CoinForm {
  symbol: string;
  name: string;
  gate_pair: string | null;
  gate_slug: string | null;
  cg_id: string;
  enabled: boolean;
  alert_above: number | null;
  alert_below: number | null;
}

const usd = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
};

function SortableRow(props: React.HTMLAttributes<HTMLTableRowElement> & { 'data-row-key': string | number }) {
  const { 'data-row-key': rowKey, attributes, listeners, setNodeRef, transform, transition, isDragging, ...rest } = props as React.HTMLAttributes<HTMLTableRowElement> & {
    'data-row-key'?: string | number;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown> | undefined;
    setNodeRef?: (el: HTMLTableRowElement | null) => void;
    transform: { x: number; y: number; scaleX: number; scaleY: number } | null;
    transition?: string | undefined;
    isDragging?: boolean;
  };
  const style: React.CSSProperties = {
    ...(rest.style ?? {}),
    transform: CSS.Transform.toString(transform ?? null),
    transition: transition ?? undefined,
    cursor: isDragging ? 'grabbing' : 'grab',
    background: isDragging ? 'rgba(24, 144, 255, 0.04)' : undefined,
  };
  return (
    <tr
      ref={setNodeRef}
      data-row-key={rowKey}
      style={style}
      {...attributes}
      {...listeners}
      {...rest}
    />
  );
}

interface RowProps {
  coin: Coin;
  onEdit: (c: Coin) => void;
  onDelete: (id: number) => void;
  onToggle: (c: Coin, enabled: boolean) => void;
}
function AlertCell({ coin }: { coin: Coin }) {
  const fmtTime = (ts: number) => {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  if (coin.alert_above === null && coin.alert_below === null) {
    return (
      <Tooltip title="点击「编辑」设置预警阈值">
        <Tag icon={<BellOutlined />} color="default" style={{ margin: 0 }}>未设置</Tag>
      </Tooltip>
    );
  }
  return (
    <Space direction="vertical" size={4} style={{ lineHeight: 1.2 }}>
      {coin.alert_above !== null && (
        <Tooltip
          title={
            coin.last_alert_dir === 'above' && coin.last_alert_at
              ? `最近一次突破通知：${fmtTime(coin.last_alert_at)}`
              : '当前价穿越该阈值时发飞书通知一次'
          }
        >
          <Tag
            icon={coin.last_alert_dir === 'above' && coin.last_alert_at ? <BellFilled /> : <ArrowUpOutlined />}
            color={coin.last_alert_dir === 'above' && coin.last_alert_at ? 'red' : 'volcano'}
            style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}
          >
            ≥ {usd(coin.alert_above)}
          </Tag>
        </Tooltip>
      )}
      {coin.alert_below !== null && (
        <Tooltip
          title={
            coin.last_alert_dir === 'below' && coin.last_alert_at
              ? `最近一次下穿通知：${fmtTime(coin.last_alert_at)}`
              : '当前价跌破该阈值时发飞书通知一次'
          }
        >
          <Tag
            icon={coin.last_alert_dir === 'below' && coin.last_alert_at ? <BellFilled /> : <ArrowDownOutlined />}
            color={coin.last_alert_dir === 'below' && coin.last_alert_at ? 'green' : 'lime'}
            style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}
          >
            ≤ {usd(coin.alert_below)}
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}

export function Coins() {
  const { message } = AntApp.useApp();
  const [list, setList] = useState<Coin[]>([]);
  const [editing, setEditing] = useState<Coin | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<CoinForm>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const refresh = async () => {
    try {
      setList(await apiGet<Coin[]>('/api/coins'));
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const stats = useMemo(() => {
    const total = list.length;
    const enabled = list.filter((c) => c.enabled).length;
    const alerted = list.filter((c) => c.alert_above !== null || c.alert_below !== null).length;
    return { total, enabled, alerted };
  }, [list]);

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, gate_pair: '', gate_slug: '', alert_above: null, alert_below: null });
    setModalOpen(true);
  };

  const openEdit = (c: Coin) => {
    setEditing(c);
    form.setFieldsValue({
      symbol: c.symbol,
      name: c.name,
      gate_pair: c.gate_pair ?? '',
      gate_slug: c.gate_slug ?? '',
      cg_id: c.cg_id,
      enabled: !!c.enabled,
      alert_above: c.alert_above,
      alert_below: c.alert_below,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const payload = {
      symbol: v.symbol.toUpperCase(),
      name: v.name,
      gate_pair: v.gate_pair && String(v.gate_pair).trim() ? String(v.gate_pair).toUpperCase() : null,
      gate_slug: v.gate_slug && String(v.gate_slug).trim() ? String(v.gate_slug).toLowerCase() : null,
      cg_id: v.cg_id,
      enabled: v.enabled,
      alert_above: v.alert_above ?? null,
      alert_below: v.alert_below ?? null,
    };
    try {
      if (editing) {
        await apiPut(`/api/coins/${editing.id}`, payload);
        message.success('已更新');
      } else {
        await apiPost('/api/coins', payload);
        message.success('已新增');
      }
      setModalOpen(false);
      await refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const remove = async (id: number) => {
    try {
      await apiDelete(`/api/coins/${id}`);
      message.success('已删除');
      await refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const toggle = async (c: Coin, enabled: boolean) => {
    try {
      await apiPut(`/api/coins/${c.id}`, { enabled });
      message.success('已更新');
      await refresh();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = list.findIndex((c) => c.id === active.id);
    const newIdx = list.findIndex((c) => c.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const newList = arrayMove(list, oldIdx, newIdx);
    setList(newList);
    try {
      await apiPost('/api/coins/reorder', { ids: newList.map((c) => c.id) });
      message.success('排序已保存');
    } catch (err) {
      message.error((err as Error).message);
      await refresh();
    }
  };

  const columns: ColumnsType<Coin> = [
    {
      title: '',
      key: 'drag',
      width: 40,
      render: () => <HolderOutlined style={{ color: '#bfbfbf' }} aria-label="拖拽排序" />,
    },
    { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 110, render: (s: string) => <Tag color="blue" style={{ fontVariantNumeric: 'tabular-nums' }}>{s}</Tag> },
    { title: '名称', dataIndex: 'name', key: 'name', width: 130 },
    { title: 'Gate Pair', dataIndex: 'gate_pair', key: 'gate_pair', render: (v: string | null) => v ? <code>{v}</code> : <span style={{ color: '#bfbfbf' }}>—</span> },
    { title: 'Gate Slug', dataIndex: 'gate_slug', key: 'gate_slug', render: (v: string | null) => v ? <code>{v}</code> : <span style={{ color: '#bfbfbf' }}>—</span> },
    { title: 'CoinGecko ID', dataIndex: 'cg_id', key: 'cg_id', render: (v: string) => <code>{v}</code> },
    { title: '顺序', dataIndex: 'sort_order', key: 'sort_order', width: 64, align: 'right' },
    {
      title: '启用', dataIndex: 'enabled', key: 'enabled', width: 72,
      render: (v: number, c) => (
        <Switch
          size="small"
          checked={!!v}
          onChange={(checked) => toggle(c, checked)}
          onClick={(_, e) => e.stopPropagation()}
        />
      ),
    },
    {
      title: '价格预警 (USDT)', key: 'alerts', width: 200,
      render: (_: unknown, c: Coin) => <AlertCell coin={c} />,
    },
    {
      title: '操作', key: 'actions', width: 110, fixed: 'right',
      render: (_: unknown, c: Coin) => (
        <Space onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(c)} aria-label={`编辑 ${c.symbol}`} />
          </Tooltip>
          <Popconfirm title={`确定删除 ${c.symbol}？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(c.id)}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${c.symbol}`} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card variant="borderless">
        <Row gutter={16} align="middle">
          <Col flex="auto">
            <Typography.Title level={4} style={{ margin: 0 }}>监控币种</Typography.Title>
            <Typography.Text type="secondary">管理推送、定时任务和价格预警阈值。拖拽行重排顺序，启用的币种会被定时任务抓取。</Typography.Text>
          </Col>
          <Col>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>新增币种</Button>
          </Col>
        </Row>
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col xs={12} sm={8} md={6}><Statistic title="总币种" value={stats.total} suffix="个" /></Col>
          <Col xs={12} sm={8} md={6}><Statistic title="已启用" value={stats.enabled} suffix="个" valueStyle={{ color: 'var(--ant-color-success)' }} /></Col>
          <Col xs={12} sm={8} md={6}><Statistic title="已设预警" value={stats.alerted} suffix="个" valueStyle={{ color: 'var(--ant-color-warning)' }} /></Col>
        </Row>
      </Card>

      <Card variant="borderless" bodyStyle={{ padding: 0 }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list.map((c) => c.id)}>
            <Table<Coin>
              rowKey="id"
              columns={columns}
              dataSource={list}
              size="middle"
              pagination={false}
              scroll={{ x: 1100 }}
              locale={{ emptyText: <Empty description="还没有币种，点右上角新增第一个" /> }}
              components={{
                body: { row: SortableRow as unknown as React.ComponentType },
              }}
              onRow={(_c): React.HTMLAttributes<HTMLTableRowElement> & { 'data-row-key'?: React.Key } => ({}) as never}
              rowClassName={() => 'cpb-coin-row'}
            />
          </SortableContext>
        </DndContext>
      </Card>

      <Modal
        title={editing ? `编辑币种 · ${editing.symbol}` : '新增币种'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={560}
      >
        <Form<CoinForm> form={form} layout="vertical" requiredMark="optional">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="symbol" label="Symbol（如 BTC）" rules={[{ required: true, pattern: /^[A-Z0-9]+$/, message: '必须是大写字母+数字' }]}>
                <Input maxLength={16} disabled={!!editing} placeholder="BTC" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="name" label="名称（如 比特币）" rules={[{ required: true }]}>
                <Input maxLength={64} placeholder="比特币" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="gate_pair" label="Gate Pair" tooltip="如 BTC_USDT；稳定币留空">
                <Input placeholder="留空表示稳定币" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="gate_slug" label="Gate Slug" tooltip="如 bitcoin；留空回退到 symbol">
                <Input placeholder="如 bitcoin" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="cg_id" label="CoinGecko ID" rules={[{ required: true }]}>
            <Input placeholder="如 bitcoin" />
              </Form.Item>
          <Form.Item name="enabled" label="启用监控" valuePropName="checked" tooltip="停用后不会被定时任务抓取">
            <Switch />
          </Form.Item>

          <Typography.Text type="secondary" style={{ display: 'block', margin: '8px 0' }}>
            价格预警（单位：USDT）— 留空表示不启用该方向。设置后下一次定时任务检测到 USD 价格首次穿越阈值会向飞书发一次提醒；冷却时长在「设置」页面调整。
          </Typography.Text>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="alert_above"
                label="突破上限 ≥"
                tooltip="当前价从下方穿越该值时触发一次飞书通知"
              >
                <InputNumber<number>
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder="留空 = 不设"
                  formatter={(v) => v !== undefined && v !== null ? `$${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                  parser={(v) => (v ? Number(String(v).replace(/[$,\s]/g, '')) : 0) as 0 as unknown as number}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="alert_below"
                label="跌破下限 ≤"
                tooltip="当前价从上方跌破该值时触发一次飞书通知"
              >
                <InputNumber<number>
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder="留空 = 不设"
                  formatter={(v) => v !== undefined && v !== null ? `$${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                  parser={(v) => (v ? Number(String(v).replace(/[$,\s]/g, '')) : 0) as unknown as number}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Space>
  );
}
