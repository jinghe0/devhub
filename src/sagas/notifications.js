// @flow

import moment from 'moment';
import { normalize } from 'normalizr';
import { delay } from 'redux-saga';
import { call, fork, put, race, select, take, takeEvery, takeLatest } from 'redux-saga/effects';
import { REHYDRATE } from 'redux-persist/constants';

import { dateToHeaderFormat, getOwnerAndRepo } from '../utils/helpers';
import { NotificationSchema } from '../utils/normalizr/schemas';

import {
  accessTokenSelector,
  isLoggedSelector,
  lastModifiedAtSelector,
  notificationSelector,
  repoSelector,
} from '../selectors';

import { authenticate, getApiMethod, requestTypes } from '../api/github';

import {
  LOAD_NOTIFICATIONS_REQUEST,
  LOGIN_SUCCESS,
  LOGOUT,
  MARK_NOTIFICATIONS_AS_READ_REQUEST,
  UPDATE_NOTIFICATIONS,
} from '../utils/constants/actions';

import type { MarkNotificationsParams } from '../actions/notifications';

import type { Action, ApiRequestPayload, ApiResponsePayload } from '../utils/types';

import {
  loadNotificationsRequest,
  loadNotificationsSuccess,
  loadNotificationsFailure,
  markNotificationsAsReadFailure,
  markNotificationsAsReadSuccess,
  updateNotifications,
} from '../actions';

const sagaActionChunk = { dispatchedBySaga: true };

function* onLoadNotificationsRequest({ payload }: Action<ApiRequestPayload>) {
  const state = yield select();
  const accessToken = accessTokenSelector(state);

  yield call(authenticate, accessToken);
  const requestPayload = { ...payload, accessToken };

  try {
    if (!accessToken) {
      throw new Error('You must be logged in to see this', 'NotAuthorizedException');
    }

    const { params, requestType } = payload;

    const { response, timeout } = yield race({
      response: call(getApiMethod(requestType), params),
      timeout: call(delay, 10000),
    });

    if (timeout) {
      throw new Error('Timeout', 'TimeoutError');
    }

    // console.log('onLoadNotificationsRequest response', response);
    const { data, meta }: ApiResponsePayload = response;

    let finalData = data || undefined;

    if (data) {
      finalData = normalize(data, [NotificationSchema]);
    }

    yield put(loadNotificationsSuccess(requestPayload, finalData, meta, sagaActionChunk));
  } catch (e) {
    console.log('onLoadNotificationsRequest catch', e, requestPayload);
    let errorMessage = (e.message || {}).message || e.message || e.body || e.status;
    if (errorMessage) errorMessage = `Failed to update notifications: ${errorMessage}`;
    yield put(loadNotificationsFailure(requestPayload, errorMessage, sagaActionChunk));
  }
}

function* onMarkNotificationsAsReadRequest({ payload }: Action<MarkNotificationsParams>) {
  const state = yield select();
  const accessToken = accessTokenSelector(state);

  yield call(authenticate, accessToken);
  const requestPayload = { ...payload, accessToken };

  try {
    if (!accessToken) {
      throw new Error('You must be logged mark notifications are read', 'NotAuthorizedException');
    }

    const { all, lastReadAt: _lastReadAt, notificationIds, repoId } = payload;
    const lastReadAt = moment(_lastReadAt || new Date()).utc().format();

    // let callMethods;
    let params;
    let requestType;
    let ignoreApiCall = false;

    if (all) {
      if (repoId) {
        const repoEntity = repoSelector(state, { repoId });
        if (!repoEntity) return;

        const { owner, repo } = getOwnerAndRepo(repoEntity.get('full_name'));

        requestType = requestTypes.MARK_ALL_NOTIFICATIONS_AS_READ_FOR_REPO;
        params = { owner, repo, last_read_at: lastReadAt };
      } else {
        requestType = requestTypes.MARK_ALL_NOTIFICATIONS_AS_READ;
        params = { last_read_at: lastReadAt };
      }
    } else {
      requestType = requestTypes.MARK_NOTIFICATION_THREAD_AS_READ;

       // TODO: Improve this. Call for all notifications.
       // Not important yet because of the way this is triggered
       // (by toggling one notification each time)
      const notificationId = notificationIds.first();

      params = { id: notificationId, last_read_at: lastReadAt };

      // dont call api again if it was already marked as read on github
      const notification = notificationSelector(state, { notificationId });
      if (notification && !notification.get('unread')) ignoreApiCall = true;
    }

    let response;
    if (!ignoreApiCall) {
      const { response: _response, timeout } = yield race({
        response: call(getApiMethod(requestType), params),
        timeout: call(delay, 10000),
      });

      if (timeout) {
        throw new Error('Timeout', 'TimeoutError');
      }

      response = _response;
    }

    const { data, meta }: ApiResponsePayload = response || {};
    yield put(markNotificationsAsReadSuccess(requestPayload, data, meta, sagaActionChunk));
  } catch (e) {
    console.log('onMarkNotificationsAsReadRequest catch', e, requestPayload);
    let errorMessage = (e.message || {}).message || e.message || e.body || e.status;
    if (errorMessage) errorMessage = `Failed to mark as read: ${errorMessage}`;
    yield put(markNotificationsAsReadFailure(requestPayload, errorMessage, sagaActionChunk));
  }
}

export function getDefaultSince() {
  return moment().subtract(1, 'month').format();
}

export function getParamsToLoadAllNotifications() {
  return { all: true, since: getDefaultSince() };
}

export function* getParamsToLoadOnlyNewNotifications() {
  const state = yield select();
  const lastModifiedAt = lastModifiedAtSelector(state);

  const defaultSince = getDefaultSince();
  return {
    all: true,
    since: defaultSince,
    headers: {
      'If-Modified-Since': dateToHeaderFormat(lastModifiedAt || defaultSince),
    },
  };
}

function* onUpdateNotificationsRequest({ payload: { params: _params } }) {
  const params = _params || (yield getParamsToLoadOnlyNewNotifications());
  yield put(loadNotificationsRequest(params, sagaActionChunk));
}

// update user notifications each minute
function* startTimer() {
  yield take(REHYDRATE);

  // when the user opens the app, load ALL notifications.
  // and then on each minute load only the new notifications
  // to optimize polling with If-Modified-Since header
  let params = getParamsToLoadAllNotifications();

  while (true) {
    const state = yield select();
    const isLogged = isLoggedSelector(state);

    if (isLogged) {
      yield put(updateNotifications(params, sagaActionChunk));
      params = yield getParamsToLoadOnlyNewNotifications();

      const { logout } = yield race({
        delay: call(delay, 60 * 1000),
        logout: take([LOGIN_SUCCESS, LOGOUT]),
      });

      if (logout) {
        params = getParamsToLoadAllNotifications();
      }
    } else {
      yield call(delay, 1000);
    }
  }
}

export default function* () {
  return yield [
    yield takeLatest(UPDATE_NOTIFICATIONS, onUpdateNotificationsRequest),
    yield takeEvery(LOAD_NOTIFICATIONS_REQUEST, onLoadNotificationsRequest),
    yield takeEvery(MARK_NOTIFICATIONS_AS_READ_REQUEST, onMarkNotificationsAsReadRequest),
    yield fork(startTimer),
  ];
}