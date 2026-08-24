//! 图片 OCR：macOS Vision 框架离线识别（VNRecognizeTextRequest，中英混排）。
//! 无网络请求；结构化接口保留置信度与 Vision 左下原点框，坐标转换由
//! image_firewall 统一完成。

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSRange, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedText, VNRecognizedTextObservation,
    VNRequest, VNRequestTextRecognitionLevel,
};
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct RecognizedObservation {
    pub text: String,
    pub confidence: f32,
    pub vision_box: (f64, f64, f64, f64),
    /// Vision 识别句柄：仅在识别线程内消费（!Send），用于字符级子框。
    recognized: Option<Retained<VNRecognizedText>>,
}

impl RecognizedObservation {
    /// UTF-16 范围的字符级 Vision 框（左下原点，归一化）。范围非法或
    /// Vision 拒绝该范围时返回 None，由调用方回退整条 observation 框。
    pub fn char_range_box(
        &self,
        start_utf16: usize,
        end_utf16: usize,
    ) -> Option<(f64, f64, f64, f64)> {
        let recognized = self.recognized.as_ref()?;
        if start_utf16 >= end_utf16 || end_utf16 > self.text.encode_utf16().count() {
            return None;
        }
        let range = NSRange {
            location: start_utf16,
            length: end_utf16 - start_utf16,
        };
        let rect = unsafe { recognized.boundingBoxForRange_error(range) }.ok()?;
        let bounds = unsafe { rect.boundingBox() };
        Some((
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        ))
    }

    #[cfg(test)]
    pub fn synthetic(text: &str, confidence: f32, vision_box: (f64, f64, f64, f64)) -> Self {
        Self {
            text: text.into(),
            confidence,
            vision_box,
            recognized: None,
        }
    }
}

pub fn recognize_observations(bytes: &[u8]) -> Result<Vec<RecognizedObservation>, String> {
    let data = NSData::with_bytes(bytes);

    // 结构化识别允许空结果；旧字符串接口再决定是否将空结果视为错误。
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let langs =
        NSArray::from_retained_slice(&[NSString::from_str("zh-Hans"), NSString::from_str("en-US")]);
    request.setRecognitionLanguages(&langs);

    let as_request: Retained<VNRequest> =
        Retained::into_super(Retained::into_super(request.clone()));
    let requests = NSArray::from_retained_slice(&[as_request]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("Vision 识别失败: {e}"))?;

    let mut observations = Vec::new();
    if let Some(results) = request.results() {
        for obs in results.iter() {
            let any: &AnyObject = &obs;
            if let Some(text_obs) = any.downcast_ref::<VNRecognizedTextObservation>() {
                if let Some(best) = text_obs.topCandidates(1).firstObject() {
                    let s = best.string().to_string();
                    if !s.trim().is_empty() {
                        let bounds = unsafe { text_obs.boundingBox() };
                        observations.push(RecognizedObservation {
                            text: s,
                            confidence: best.confidence(),
                            vision_box: (
                                bounds.origin.x,
                                bounds.origin.y,
                                bounds.size.width,
                                bounds.size.height,
                            ),
                            recognized: Some(best),
                        });
                    }
                }
            }
        }
    }
    Ok(observations)
}

/// 旧图片卡 OCR 契约：仍返回换行拼接文本，空结果维持原错误语义。
pub fn recognize(app: &AppHandle, file: &str) -> Result<String, String> {
    let bytes = crate::storage::read_image_bytes(app, file).ok_or("图片不存在")?;
    let text = recognize_observations(&bytes)?
        .into_iter()
        .map(|observation| observation.text)
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        Err("未识别到文字".into())
    } else {
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    /// 手工发布门禁：fixture 必须只含 synthetic 数据；不把识别正文打印到日志。
    #[test]
    #[ignore = "设置 TOSKR_SYNTHETIC_OCR_FIXTURE 后手工运行"]
    fn synthetic_fixture_recognizes_email_and_fake_api_key() {
        let path =
            std::env::var("TOSKR_SYNTHETIC_OCR_FIXTURE").expect("缺少 synthetic OCR fixture 路径");
        let bytes = std::fs::read(path).expect("读取 synthetic OCR fixture 失败");
        let result = crate::image_firewall::scan_fixture_bytes("synthetic.png", &bytes)
            .expect("图片 Firewall 扫描失败");
        assert!(result.image_width > 0 && result.image_height > 0);
        assert!(result.observations.iter().all(|observation| {
            let bounds = observation.bounding_box;
            observation.image_width == result.image_width
                && observation.image_height == result.image_height
                && observation.confidence >= 0.0
                && observation.confidence <= 1.0
                && bounds.x >= 0.0
                && bounds.y >= 0.0
                && bounds.x + bounds.width <= 1.0
                && bounds.y + bounds.height <= 1.0
        }));
        assert!(
            result
                .findings
                .iter()
                .any(|finding| finding.category == crate::privacy::FindingCategory::Email),
            "synthetic 邮箱未被识别"
        );
        assert!(
            result
                .findings
                .iter()
                .any(|finding| finding.category == crate::privacy::FindingCategory::ApiKey),
            "synthetic API key 未被识别"
        );

        // 字符级框应落在所属 observation 框内（允许 Vision 的松弛容差）
        const TOLERANCE: f64 = 0.05;
        for finding in &result.findings {
            let observation = &result.observations[finding.observation_index];
            let outer = observation.bounding_box;
            let inner = finding.bounding_box;
            assert!(inner.x >= outer.x - TOLERANCE, "finding 框超出 observation 左缘");
            assert!(
                inner.x + inner.width <= outer.x + outer.width + TOLERANCE,
                "finding 框超出 observation 右缘"
            );
            assert!(inner.y >= outer.y - TOLERANCE, "finding 框超出 observation 上缘");
            assert!(
                inner.y + inner.height <= outer.y + outer.height + TOLERANCE,
                "finding 框超出 observation 下缘"
            );
        }

        // 遮挡复检闭环：按 finding 区域实色遮挡后重新 OCR，遮挡区域内不得再识别出文字
        let regions: Vec<_> = result
            .findings
            .iter()
            .map(|finding| finding.pixel_box)
            .collect();
        assert!(!regions.is_empty());
        let original = image::load_from_memory(&bytes).expect("解码 fixture 失败").to_rgba8();
        let redacted = crate::image_firewall::solid_redacted_copy(&original, &regions);
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(redacted)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("编码遮挡副本失败");
        let residual = crate::ocr::recognize_observations(png.get_ref()).expect("复检 OCR 失败");
        let boxes: Vec<_> = residual
            .iter()
            .map(|observation| {
                let (x, y, width, height) = observation.vision_box;
                crate::image_firewall::normalized_to_pixels(
                    crate::image_firewall::vision_box_to_top_left(x, y, width, height),
                    result.image_width,
                    result.image_height,
                    0,
                )
            })
            .collect();
        assert!(
            !crate::image_firewall::redacted_regions_still_show_text(&boxes, &regions),
            "遮挡区域内复检仍识别出文字"
        );
    }
}
