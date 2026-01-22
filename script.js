// Dashboard script for Northern Ireland disease prevalence

// Helper to format numbers with thousands separator
const formatNumber = d3.format(',');
const formatDecimal = d3.format('.2f');

// Load the pre-computed data (JSON generated in advance)
d3.json('ni_prevalence_data.json').then(data => {
  const conditions = Object.keys(data.condition_data).sort();
  const select = d3.select('#condition-select');
  // Populate the drop‑down selector
  select
    .selectAll('option')
    .data(conditions)
    .enter()
    .append('option')
    .attr('value', d => d)
    .text(d => d);

  // Set initial selection to first condition
  const initialCondition = conditions[0];
  select.property('value', initialCondition);
  updateDashboard(initialCondition);

  // Update dashboard whenever the selection changes
  select.on('change', function() {
    const cond = this.value;
    updateDashboard(cond);
  });

  /**
   * Update the cards, map, and table based on the selected register
   * @param {string} condition - name of the clinical register
   */
  /**
   * Rebuild cards, table and map when the selected condition changes.
   * Resets pagination state.
   */
  function updateDashboard(condition) {
    // Update score cards
    const totals = data.condition_totals[condition];
    d3.select('#card-total').text(formatNumber(totals.total_patients));
    d3.select('#card-prev').text(formatDecimal(totals.prevalence_per_1000));

    // Prepare features (only practices with coordinates and data for this condition)
    const features = [];
    for (const [pid, info] of Object.entries(data.practice_info)) {
      const condData = data.condition_data[condition][pid];
      if (!condData) continue;
      const lat = +info.latitude;
      const lon = +info.longitude;
      if (isNaN(lat) || isNaN(lon)) continue;
      features.push({
        id: pid,
        name: info.name,
        latitude: lat,
        longitude: lon,
        prevalence: condData.prevalence_per_1000,
        patients: condData.patients
      });
    }

    // Sort features by number of patients for the table
    currentTableData = features.slice().sort((a, b) => d3.descending(a.patients, b.patients));
    // Reset to first page whenever condition changes
    currentPage = 1;
    // Update table and pagination
    updateTable();
    renderPagination();
    // Update map
    updateMap(features);
  }

  /**
   * Render the map with Voronoi polygons coloured by prevalence
   * @param {Array<Object>} pointsData - array with lat, lon, prevalence and other meta
   */
  function updateMap(pointsData) {
    const svg = d3.select('#map');
    const width = +svg.attr('width');
    const height = +svg.attr('height');
    svg.selectAll('*').remove();

    if (pointsData.length === 0) {
      return;
    }

    // Projection centred roughly on Northern Ireland
    const projection = d3.geoMercator()
      .center([-6.7, 54.6])
      .scale(8000)
      .translate([width / 2, height / 2]);

    // Convert lat/lon to x,y coordinates
    const projectedPoints = pointsData.map(d => {
      const [x, y] = projection([d.longitude, d.latitude]);
      return { ...d, x, y };
    });

    // Compute a convex hull around the practice points to approximate the Northern Ireland boundary.
    const hullPoints = d3.polygonHull(projectedPoints.map(d => [d.x, d.y]));

    // Compute colour scale based on prevalence

    // Compute colour scale based on prevalence
    const prevalenceValues = projectedPoints.map(d => d.prevalence);
    // Define a custom purple colour palette (light to dark) inspired by PCRNI branding
    const purplePalette = ['#efedf5','#dadaeb','#bcbddc','#9e9ac8','#807dba','#6a51a3','#54278f'];
    const colourScale = d3.scaleQuantile()
      .domain(prevalenceValues)
      .range(purplePalette);

    // Generate Voronoi diagram
    const delaunay = d3.Delaunay.from(projectedPoints, d => d.x, d => d.y);
    const voronoi = delaunay.voronoi([0, 0, width, height]);

    // Tooltip
    const tooltip = d3.select('body').append('div')
      .attr('class', 'tooltip')
      .style('opacity', 0);

    // Draw each cell
    svg.append('g')
      .selectAll('path')
      .data(projectedPoints)
      .enter()
      .append('path')
      .attr('d', (_, i) => voronoi.renderCell(i))
      .attr('fill', d => colourScale(d.prevalence))
      .attr('stroke', '#fff')
      .attr('stroke-width', 0.3)
      .on('mousemove', (event, d) => {
        tooltip
          .style('opacity', 1)
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY + 10) + 'px')
          .html(`<strong>${d.name}</strong><br/>Patients: ${formatNumber(d.patients)}<br/>Prevalence per 1,000: ${formatDecimal(d.prevalence)}<br/>Prevalence per 1,000 (50+): ${d.prevalence50 != null ? formatDecimal(d.prevalence50) : '–'}`);
      })
      .on('mouseout', () => {
        tooltip.style('opacity', 0);
      });

    // Draw boundary hull if it exists
    if (hullPoints) {
      svg.append('path')
        .datum(hullPoints)
        .attr('d', d3.line())
        .attr('fill', 'none')
        .attr('stroke', '#333')
        .attr('stroke-width', 1.5);
    }

    // Draw legend
    const legend = d3.select('#legend');
    legend.selectAll('*').remove();
    const quantiles = colourScale.quantiles();
    // Build legend items: there are n bins equal to range length
    const colours = colourScale.range();
    const bins = [];
    for (let i = 0; i < colours.length; i++) {
      const min = i === 0 ? d3.min(prevalenceValues) : quantiles[i - 1];
      const max = i < quantiles.length ? quantiles[i] : d3.max(prevalenceValues);
      bins.push({ colour: colours[i], min, max });
    }
    const items = legend.selectAll('.legend-item')
      .data(bins)
      .enter()
      .append('div')
      .attr('class', 'legend-item');
    items.append('div')
      .attr('class', 'color-box')
      .style('background-color', d => d.colour);
    items.append('span')
      .text(d => `${formatDecimal(d.min)} – ${formatDecimal(d.max)}`);
  }
});