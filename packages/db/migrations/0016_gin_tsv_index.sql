-- 关键词检索的 GIN 倒排索引。
-- 此前 chunks 上只有主键和 doc_id 索引，`WHERE to_tsvector('simple', tsv_text) @@ to_tsquery(...)`
-- 是**全表扫描 + 逐行实时计算 tsvector**：语料一大就线性劣化，且每次查询都在重复做同样的分词解析。
-- 表达式索引必须与查询里的表达式**逐字一致**（同为 'simple' 配置）才会被规划器选中。
-- BM25 打分要按词统计文档频率(DF)，同样依赖这个索引才能快。
CREATE INDEX IF NOT EXISTS chunks_tsv_gin ON chunks USING GIN (to_tsvector('simple', tsv_text));
