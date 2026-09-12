'use client';
import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import type { ObservationSkillChain } from '../../../../observability/contracts/skill-chain';
import type { Language } from '../layout/shell';

/** Skill 链路（#839 批次 5）：每个 skill 的定义与体检链路状态概要。 */
export function SkillChains({
  chains,
  lang,
}: {
  chains: Record<string, ObservationSkillChain>;
  lang: Language;
}) {
  const zh = lang === 'zh';
  const entries = Object.entries(chains).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return <Empty description={zh ? '暂无 skill 链路。' : 'No skill chains yet.'} />;
  }
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {entries.map(([skillName, chain]) => {
        const hardRules = chain.healthCheck.hardRules;
        return (
          <Card
            key={skillName}
            size="small"
            title={<Typography.Text strong code>{skillName}</Typography.Text>}
          >
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label={zh ? 'SKILL.md' : 'SKILL.md'}>
                {chain.definition.found
                  ? <Tag color="success">{zh ? '已找到' : 'Found'}</Tag>
                  : <Tag color="error">{zh ? '缺失' : 'Missing'}</Tag>}
                {chain.definition.path ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{chain.definition.path}</Typography.Text>
                ) : null}
              </Descriptions.Item>
              <Descriptions.Item label={zh ? '硬性规则' : 'Hard rules'}>
                {hardRules.declared
                  ? (
                      <>
                        <Tag color={hardRules.valid ? 'success' : 'error'}>
                          {hardRules.valid ? (zh ? '有效' : 'Valid') : (zh ? '异常' : 'Invalid')}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {hardRules.count}
                        </Typography.Text>
                      </>
                    )
                  : <Tag>{zh ? '未声明' : 'Not declared'}</Tag>}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        );
      })}
    </Space>
  );
}
