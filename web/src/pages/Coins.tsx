import { useEffect, useState } from 'react';
import {
  Table, Button, Switch, Modal, Form, Input, Popconfirm, App as AntApp, Space, Tag,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { DndContext, type DragEndEvent, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiDelete, apiGet, apiPost, apiPut, type Coin } from '../api/client';

interface CoinForm {
  symbol: string;
  name: string;
  gate_pair: string | null;
  cg_id: string;
  enabled: boolean;
}

function SortableRow({ coin, onEdit, onDelete, onToggle }: {
  coin: Coin;
  onEdit: (c: Coin) => void;
  onDelete: (id: number) => void;
  onToggle: (c: Coin, enabled: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: coin.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: 'pointer',
    background: isDragging ? '#fafafa' : undefined,
  };
  return (
    <tr ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <td>
        <Space>
          <span style={{ color: '#999' }}>⠿</span>
          <Tag color="blue">{coin.symbol}</Tag>
        </Space>
      </td>
      <td>{coin.name}</td>
      <td><code>{coin.gate_pair ?? '—'}</code></td>
      <td><code>{coin.cg_id}</code></td>
      <td>{coin.sort_order}</td>
      <td>
        <Switch
          checked={!!coin.enabled}
          onChange={(v) => onToggle(coin, v)}
          onClick={(_, e) => e.stopPropagation()}
        />
      </td>
      <td>
        <Space onPointerDown={(e) => e.stopPropagation()}>
          <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(coin)} />
          <Popconfirm title="确定删除？" onConfirm={() => onDelete(coin.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </td>
    </tr>
  );
}

export function Coins() {
  const { message } = AntApp.useApp();
  const [list, setList] = useState<Coin[]>([]);
  const [editing, setEditing] = useState<Coin | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<CoinForm>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const refresh = async () => {
    try {
      setList(await apiGet<Coin[]>('/api/coins'));
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, gate_pair: '' });
    setModalOpen(true);
  };

  const openEdit = (c: Coin) => {
    setEditing(c);
    form.setFieldsValue({
      symbol: c.symbol,
      name: c.name,
      gate_pair: c.gate_pair ?? '',
      cg_id: c.cg_id,
      enabled: !!c.enabled,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const payload = {
      symbol: v.symbol.toUpperCase(),
      name: v.name,
      gate_pair: v.gate_pair && v.gate_pair.trim() ? v.gate_pair.toUpperCase() : null,
      cg_id: v.cg_id,
      enabled: v.enabled,
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

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>新增币种</Button>
      </Space>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={th}>Symbol</th>
              <th style={th}>名称</th>
              <th style={th}>Gate Pair</th>
              <th style={th}>CoinGecko ID</th>
              <th style={th}>顺序</th>
              <th style={th}>启用</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <SortableContext items={list.map((c) => c.id)}>
            <tbody>
              {list.map((c) => (
                <SortableRow key={c.id} coin={c} onEdit={openEdit} onDelete={remove} onToggle={toggle} />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>

      <Modal
        title={editing ? '编辑币种' : '新增币种'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        destroyOnClose
      >
        <Form<CoinForm> form={form} layout="vertical">
          <Form.Item name="symbol" label="Symbol（如 BTC）" rules={[{ required: true, pattern: /^[A-Z0-9]+$/, message: '必须是大写字母+数字' }]}>
            <Input maxLength={16} disabled={!!editing} />
          </Form.Item>
          <Form.Item name="name" label="名称（如 比特币）" rules={[{ required: true }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="gate_pair" label="Gate Pair（如 BTC_USDT；稳定币留空）">
            <Input placeholder="留空表示稳定币" />
          </Form.Item>
          <Form.Item name="cg_id" label="CoinGecko ID（如 bitcoin）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontWeight: 500 };