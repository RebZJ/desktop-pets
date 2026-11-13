pub fn panel_position(pet: [i32; 4], monitor: [i32; 4], panel: [i32; 2], gap: i32) -> (i32, i32) {
    let [px, py, pw, ph] = pet;
    let [mx, my, mw, mh] = monitor;
    let [w, h] = panel;
    let min_x = mx.saturating_add(gap);
    let min_y = my.saturating_add(gap);
    let max_x = mx
        .saturating_add(mw)
        .saturating_sub(w)
        .saturating_sub(gap)
        .max(min_x);
    let max_y = my
        .saturating_add(mh)
        .saturating_sub(h)
        .saturating_sub(gap)
        .max(min_y);
    let x = px
        .saturating_add(pw / 2)
        .saturating_sub(w / 2)
        .clamp(min_x, max_x);
    let above = py.saturating_sub(h).saturating_sub(gap);
    let y = if above >= min_y {
        above
    } else {
        py.saturating_add(ph).saturating_add(gap)
    }
    .clamp(min_y, max_y);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clouds_follow_the_pet_and_stay_inside_each_monitor() {
        assert_eq!(
            panel_position([1100, 700, 224, 232], [0, 0, 1440, 1000], [420, 330], 12),
            (1002, 358)
        );
        assert_eq!(
            panel_position([2, 2, 224, 232], [0, 0, 800, 600], [480, 400], 12),
            (12, 188)
        );
        assert_eq!(
            panel_position(
                [-1900, 700, 224, 232],
                [-1920, 0, 1920, 1080],
                [420, 330],
                12
            ),
            (-1908, 358)
        );
    }
}
