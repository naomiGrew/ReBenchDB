function determineAndDisplaySignificance() {
  const val = $('#significance').val();
  displaySignificance(val);
}

function displaySignificance(sig) {
  $('#significance-val').val(`${sig}%`);
  $('.stats-change').each((i, e) => {
    const change = parseFloat(<string>e.textContent);
    const parent = $(e).parent();
    const target = parent.find('.stats-change').length > 1 ? $(e) : parent;
    if (change < -sig) {
      target.css('background-color', '#e4ffc7');
    } else if (change > sig) {
      target.css('background-color', '#ffcccc');
    } else {
      target.css('background-color', '');
    }
  });
}

function insertWarmupPlot(e) {
  const jqButton = $(e.target);
  const url = jqButton.data('img');
  const insert = `<tr><td class="warmup-plot" colspan="6">
      <img src="${url}"></td></tr>`;
  jqButton.parent().parent().after(insert);
  jqButton.remove();
}

function createEntry(e, profId, counter) {
  let entryHtml = '';
  const justStr = typeof e === 'string';

  const hasTrace = !justStr && e.t !== undefined;

  if (hasTrace) {
    // eslint-disable-next-line max-len
    entryHtml += `<a href="#${profId}-item-${counter.cnt}" data-toggle="collapse">`;
  } else {
    entryHtml += `<span>`;
  }

  const percent = justStr ? '' : e.p.toFixed(2);
  entryHtml += `<span class="percent">${percent}</span> `;

  if (hasTrace) {
    entryHtml += `<span class="glyph glyph-plus"></span> `;
  }

  if (justStr) {
    entryHtml += e;
  } else {
    entryHtml += e.m;
  }

  if (hasTrace) {
    entryHtml += `</a>`;

    // eslint-disable-next-line max-len
    entryHtml += `<div class="list-group collapse" id="${profId}-item-${counter.cnt}">`;

    for (const te of e.t) {
      counter.cnt += 1;
      entryHtml += createEntry(te, profId, counter);
    }

    entryHtml += `</div>`;
  } else {
    entryHtml += `</span>`;
  }

  return entryHtml;
}

function fetchProfile(change, runId, trialId, jqInsert) {
  const profileP = fetch(
    `/rebenchdb/dash/{{project}}/profiles/${runId}/${trialId}`
  );
  profileP.then(async (profileResponse) => {
    const profileData = await profileResponse.json();
    const profId = `prof-${change}-${runId}-${trialId}`;

    const container = jqInsert.children();
    let mainContent = `<div class="list-group list-group-root">`;

    const counter = { cnt: 0 };
    for (const e of profileData.profile) {
      counter.cnt += 1;
      if (e.p <= 0.1) {
        break;
      }
      mainContent += createEntry(e, profId, counter);
    }

    mainContent += `</div>`;
    container.append(mainContent);

    $('.list-group-item').on('click', function () {
      $('.glyph', container)
        .toggleClass('glyph-plus')
        .toggleClass('glyph-minus');
    });
  });
}

function insertProfiles(e) {
  const jqButton = $(e.target);
  let profileInsertTarget = jqButton.parent().parent();
  jqButton.remove();

  const profilesIds = jqButton.data('content').split(',');
  for (const ids of profilesIds) {
    const [change, runId, trialId] = ids.split('/');

    const jqInsert = $(
      `<tr><td class="profile-container" colspan="6"></td></tr>`
    );
    profileInsertTarget.after(jqInsert);
    profileInsertTarget = jqInsert;
    fetchProfile(change, runId, trialId, jqInsert);
  }
}

$(() => {
  $('#significance').on('input', determineAndDisplaySignificance);
  determineAndDisplaySignificance();

  $('#show-refresh-form').click(() => $('input[name=password]').show());

  (<any>$)('.btn-popover').popover({ html: true, placement: 'top' });
  $('.btn-expand').click(insertWarmupPlot);
  $('.btn-profile').click(insertProfiles);

  const headlinesForTablesWithWarmupPlots = $('table:has(button.btn-expand)')
    .prev()
    .prev();
  headlinesForTablesWithWarmupPlots.append(
    `<button type="button" class="btn btn-sm btn-light btn-expand"></button>`
  );
  const buttons = headlinesForTablesWithWarmupPlots.find('.btn-expand');
  buttons.click((e) => {
    const expandButtons = $(e.target)
      .parent()
      .next()
      .next()
      .find('.btn-expand');
    expandButtons.each((i, elm) => insertWarmupPlot(elm));
  });
});
