import { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Button, List, Tag, App as AntApp, Space } from 'antd';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { apiGet, apiPost, type Status, type Report } from '../api/client';

export function Dashboard() {
  const { message } = AntApp.useApp();
  const [status, setStatus] = useState<Status | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [running, setRunning] = useState(false);

  const refresh = async () => {
    try {
      const [s, r] = await Promise.all([
        apiGet<Status>('/api/status'),
        apiGet<Report[]>('/api/reports?limit=5'),
      ]);
      setStatus(s);
      setReports(r);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await apiPost<{ reportId: number; success: boolean; totalCoins: number; okCoins: number; tgSent: boolean; feishuSent: boolean }>('/api/task/run');
      message.success(`任务完成：${res.okCoins}/${res.totalCoins} 成功（报告 #${res.reportId}）`);
      await refresh();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (!status) return null;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="监控币种" value={status.totalCoins} suffix="个" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="最近推送"
              value={status.lastReportAt ? dayjs(status.lastReportAt).format('MM-DD HH:mm') : '暂无'}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="下次推送"
              value={status.nextRunAt ? dayjs(status.nextRunAt).format('MM-DD HH:mm') : 'N/A'}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="运行状态"
              value={status.dbOk ? '正常' : '异常'}
              valueStyle={{ color: status.dbOk ? '#3f8600' : '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title="快捷操作"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={runNow} loading={running}>
              立即执行
            </Button>
          </Space>
        }
      >
        <Space direction="vertical">
          <div>调度规则：<code>{status.scheduleRule}</code>（时区 {status.timezone}）</div>
          <div>版本：<code>{status.version}</code> · SQLite {status.sqliteVersion ?? '?'} · 启动 {Math.floor(status.uptime)}s</div>
        </Space>
      </Card>

      <Card title="最近 5 份报表">
        <List
          dataSource={reports}
          locale={{ emptyText: '暂无报表' }}
          renderItem={(r) => (
            <List.Item key={r.id}>
              <Space>
                <Tag color={r.success ? 'green' : 'red'}>#{r.id}</Tag>
                <span>{dayjs(r.created_at).format('YYYY-MM-DD HH:mm:ss')}</span>
                <Tag>{r.triggered_by}</Tag>
                <span>成功 {r.ok_coins}/{r.total_coins}</span>
                {r.tg_sent ? <Tag color="blue">TG ✓</Tag> : null}
                {r.feishu_sent ? <Tag color="cyan">飞书 ✓</Tag> : null}
              </Space>
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}